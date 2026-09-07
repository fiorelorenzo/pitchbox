// Public code repositories the companion can talk about (Lorenzo's decision,
// 2026-09-07): by URL, no credential. The optional GitHub App for private
// repos is a later issue - this module only ever calls GitHub's anonymous
// REST API and caches what it read into `github_sources`
// (shared/src/db/schema.ts), which `assist/context.ts` reads from when it
// builds a suggestion prompt.
//
// Anonymous REST is capped at 60 requests/hour per calling IP
// (docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api), and
// one refresh costs three calls (repo metadata, README, commits). That is the
// entire reason a TTL exists: refreshing on every prompt build would exhaust
// the budget after five suggestions on an instance with even a handful of
// sources. `REFRESH_TTL_MS` below is the number that reasoning produced.

import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type GithubSourceRow = typeof schema.githubSources.$inferSelect;

/**
 * How long a cached read stays fresh before a refresh is attempted again.
 *
 * 6 hours: a repo's README and last-10-commits rarely change in a way that
 * matters to a prompt more than a couple of times a day, and this keeps the
 * worst case - `refreshStaleGithubSources` running on a schedule across every
 * source on the instance - to 4 refreshes/day/source, i.e. 12 requests/day/
 * source. That stays well inside the 60/hour anonymous ceiling even shared
 * across several organisations, while still giving same-day visibility to a
 * repo that was pushed to this morning.
 */
export const REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

/** Clamp for the README excerpt carried into a prompt - enough to convey what
 * a project is, not the whole file. */
export const README_EXCERPT_MAX_CHARS = 1200;

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_HOSTS: Record<string, true> = { 'github.com': true, 'www.github.com': true };

export type ParsedRepoUrl =
  { ok: true; owner: string; repo: string; url: string } | { ok: false; reason: string };

/**
 * Accepts `https://github.com/owner/repo` with or without `.git`, a trailing
 * slash, or a deeper path (`/tree/main`, `/issues`, ...), and bare `owner/repo`
 * shorthand. Anything else - including a URL to a different host - is
 * rejected with a reason instead of guessed at, per Github's non-goal: this
 * never resolves a credential, so it must never resolve an ambiguous input
 * into the wrong repository either.
 */
export function parseRepoUrl(input: string): ParsedRepoUrl {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'a repository URL is required' };

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes('github.com');
  if (!looksLikeUrl) {
    // No scheme and no github.com mention: only "owner/repo" shorthand is
    // accepted here, nothing else - a bare word or a path fragment is
    // ambiguous and must not silently become a URL.
    const match = trimmed.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    if (!match) {
      return {
        ok: false,
        reason: `"${input}" is not a GitHub URL or an "owner/repo" shorthand`,
      };
    }
    const [, owner, repo] = match;
    return { ok: true, owner, repo, url: `https://github.com/${owner}/${repo}` };
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: `"${input}" is not a valid URL` };
  }

  if (!GITHUB_HOSTS[url.hostname.toLowerCase()]) {
    return { ok: false, reason: `"${url.hostname}" is not github.com` };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const [owner, rawRepo] = parts;
  if (!owner || !rawRepo) {
    return { ok: false, reason: `"${input}" has no owner/repo path` };
  }
  const repo = rawRepo.replace(/\.git$/, '');
  return { ok: true, owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Strips a badge/shield markdown image (optionally link-wrapped) so a line
 * made entirely of them collapses to nothing rather than surviving as markup
 * a prompt has no use for. */
const BADGE_MARKDOWN_RE = /\[?!\[[^\]]*\]\([^)]*\)\]?(?:\([^)]*\))?/g;

/** Raw HTML, which a README on GitHub may use freely and which is pure noise
 * in a prompt. Measured on this repo's own README (2026-09-07): the first 200
 * characters the excerpt carried were a `<p align="left">` wrapping two
 * `<img>` wordmarks, so the model was handed markup instead of the sentence
 * that says what the project is. */
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

function excerptReadme(raw: string): string {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
  const proseLines = withoutComments.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // keep blank lines: they separate paragraphs
    // A line is dropped when nothing but badges, HTML and punctuation is
    // left once both are removed. `[a-z0-9]` rather than "non-empty": a line
    // reduced to `|` or `---` is a table rule or a divider, not prose.
    const stripped = trimmed.replace(BADGE_MARKDOWN_RE, '').replace(HTML_TAG_RE, '');
    return /[a-z0-9]/i.test(stripped);
  });
  return (
    proseLines
      .join('\n')
      // Inline HTML around real prose (a `<b>` mid-sentence, an `<img>` before
      // the first word) is removed rather than dropping the whole line with it.
      .replace(HTML_TAG_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, README_EXCERPT_MAX_CHARS)
      .trim()
  );
}

/** What this module actually needs from `fetch`: a string URL and headers.
 * Narrower than `typeof fetch` on purpose - a test double that only accepts a
 * string is a valid substitute here, while `typeof fetch` demands the
 * `Request`/`URL` overloads this code never calls. */
export type GithubFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

type RefreshOptions = {
  /** Injectable fetch, defaults to the global one. Tests substitute a mock so
   * this never actually reaches GitHub. */
  fetchImpl?: GithubFetch;
  ttlMs?: number;
};

async function recordFetchError(db: Db, id: number, message: string): Promise<void> {
  // Deliberately leaves description/readmeExcerpt/recentCommits untouched: a
  // repo that stopped resolving keeps whatever it last carried into the
  // prompt rather than going blank, and Settings surfaces `fetch_error`
  // separately so the operator knows it is stale. `fetched_at` still moves
  // forward so the TTL stops this from being retried on every single call.
  await db
    .update(schema.githubSources)
    .set({ fetchError: message, fetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.githubSources.id, id));
}

/**
 * Refreshes one source's cached GitHub data, unless it was fetched within
 * `ttlMs`. Never throws for a fetch failure - a repo that 404s, rate-limits,
 * or times out on the network is a stored `fetch_error`, not a 500 that would
 * take the caller (an add, or a scheduled sweep) down with it.
 */
export async function refreshGithubSource(
  db: Db,
  id: number,
  opts: RefreshOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = opts.ttlMs ?? REFRESH_TTL_MS;

  const [row] = await db.select().from(schema.githubSources).where(eq(schema.githubSources.id, id));
  if (!row) return;

  if (row.fetchedAt && Date.now() - row.fetchedAt.getTime() < ttlMs) return;

  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}`;
  const headers = { Accept: 'application/vnd.github+json' };

  let repoRes: Response;
  try {
    repoRes = await fetchImpl(base, { headers });
  } catch (err) {
    await recordFetchError(db, id, `network error: ${(err as Error).message}`);
    return;
  }

  if (repoRes.status === 404) {
    await recordFetchError(db, id, 'repository not found (private or deleted)');
    return;
  }
  if (repoRes.status === 403) {
    // GitHub answers a rate-limited anonymous call with 403 and
    // X-RateLimit-Remaining: 0, distinct from an ordinary 403 (e.g. a repo
    // an org blocked the API from) which does not carry that header at zero.
    if (repoRes.headers.get('x-ratelimit-remaining') === '0') {
      await recordFetchError(
        db,
        id,
        'GitHub anonymous rate limit reached (60 requests/hour per IP); will retry later',
      );
    } else {
      await recordFetchError(db, id, 'GitHub API refused the request (403)');
    }
    return;
  }
  if (!repoRes.ok) {
    await recordFetchError(db, id, `GitHub API returned ${repoRes.status}`);
    return;
  }

  const repoJson = (await repoRes.json()) as {
    description?: string | null;
    language?: string | null;
  };

  // README and commits are best-effort past this point: a repo with no
  // README (GitHub answers 404) or a transient failure on either call is not
  // worth discarding the metadata already fetched over.
  let readmeExcerpt: string | null = null;
  try {
    const readmeRes = await fetchImpl(`${base}/readme`, { headers });
    if (readmeRes.ok) {
      const readmeJson = (await readmeRes.json()) as { content?: string; encoding?: string };
      if (readmeJson.encoding === 'base64' && readmeJson.content) {
        readmeExcerpt = excerptReadme(Buffer.from(readmeJson.content, 'base64').toString('utf8'));
      }
    }
  } catch {
    // Leave readmeExcerpt null; the repo metadata above still lands.
  }

  let recentCommits: Array<{ sha: string; message: string; committedAt: string | null }> = [];
  try {
    const commitsRes = await fetchImpl(`${base}/commits?per_page=10`, { headers });
    if (commitsRes.ok) {
      const commitsJson = (await commitsRes.json()) as Array<{
        sha: string;
        commit?: { message?: string; committer?: { date?: string } };
      }>;
      recentCommits = commitsJson.map((c) => ({
        sha: c.sha,
        // Subject line only (docs/design intent: this feeds a prompt, and a
        // multi-paragraph commit body is noise there).
        message: (c.commit?.message ?? '').split('\n')[0],
        committedAt: c.commit?.committer?.date ?? null,
      }));
    }
  } catch {
    // Leave recentCommits empty; still better than throwing away the rest.
  }

  await db
    .update(schema.githubSources)
    .set({
      description: repoJson.description ?? null,
      primaryLanguage: repoJson.language ?? null,
      readmeExcerpt,
      recentCommits,
      fetchedAt: new Date(),
      fetchError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.githubSources.id, id));
}

/** All of an organization's sources, oldest-added first. */
export async function listGithubSources(
  db: Db,
  organizationId: number,
): Promise<GithubSourceRow[]> {
  return db
    .select()
    .from(schema.githubSources)
    .where(eq(schema.githubSources.organizationId, organizationId))
    .orderBy(asc(schema.githubSources.id));
}

export type AddGithubSourceResult =
  | { ok: true; source: GithubSourceRow }
  | { ok: false; code: 'invalid_url'; reason: string }
  | { ok: false; code: 'duplicate'; reason: string };

/**
 * Parses and inserts a repository, then does its first fetch inline so the
 * caller gets back a source that already has data (or already has its error)
 * rather than an empty row that only fills in on the next sweep.
 */
export async function addGithubSource(
  db: Db,
  organizationId: number,
  input: string,
  opts: RefreshOptions & { projectId?: number | null } = {},
): Promise<AddGithubSourceResult> {
  const parsed = parseRepoUrl(input);
  if (!parsed.ok) return { ok: false, code: 'invalid_url', reason: parsed.reason };

  const inserted = await db
    .insert(schema.githubSources)
    .values({
      organizationId,
      projectId: opts.projectId ?? null,
      owner: parsed.owner,
      repo: parsed.repo,
      url: parsed.url,
    })
    .onConflictDoNothing({
      target: [
        schema.githubSources.organizationId,
        schema.githubSources.owner,
        schema.githubSources.repo,
      ],
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    return {
      ok: false,
      code: 'duplicate',
      reason: `${parsed.owner}/${parsed.repo} is already in this organization's sources`,
    };
  }

  await refreshGithubSource(db, row.id, opts);

  const [fresh] = await db
    .select()
    .from(schema.githubSources)
    .where(eq(schema.githubSources.id, row.id));
  return { ok: true, source: fresh ?? row };
}

/** Deletes a source, scoped to the caller's organization. Returns false when
 * the id does not exist or belongs to a different organization - the caller
 * turns that into a 404, never a 403, so a probe against another org's id
 * learns nothing. */
export async function removeGithubSource(
  db: Db,
  organizationId: number,
  id: number,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.githubSources)
    .where(
      and(eq(schema.githubSources.id, id), eq(schema.githubSources.organizationId, organizationId)),
    )
    .returning({ id: schema.githubSources.id });
  return deleted.length > 0;
}

/**
 * Refreshes every active source whose cache is missing or older than the
 * TTL, across the whole instance. Meant to be called from a scheduled sweep
 * (wiring that up is a later issue); safe to call repeatedly since each
 * refresh re-checks its own TTL. Returns how many sources it attempted.
 */
export async function refreshStaleGithubSources(
  db: Db,
  opts: RefreshOptions = {},
): Promise<number> {
  const ttlMs = opts.ttlMs ?? REFRESH_TTL_MS;
  const cutoff = new Date(Date.now() - ttlMs);
  const stale = await db
    .select({ id: schema.githubSources.id })
    .from(schema.githubSources)
    .where(
      and(
        eq(schema.githubSources.active, true),
        or(isNull(schema.githubSources.fetchedAt), lt(schema.githubSources.fetchedAt, cutoff)),
      ),
    );
  for (const { id } of stale) {
    await refreshGithubSource(db, id, opts);
  }
  return stale.length;
}
