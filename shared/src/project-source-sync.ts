// Fetches (or explains why it can't fetch) one project source's content
// (#432). A project source's `config`/`output`/`fetch_error` shape is
// generic across all eight `PROJECT_SOURCE_KINDS` (project-sources.ts), but
// only `github` has a real fetcher wired up here today - `website` is #433
// and the three LinkedIn kinds are #435's spike, neither implemented in this
// repo yet. `folder`/`git`/`upload` are populated by starting an extraction
// run (cli/src/commands/project.ts's recordExtractionSource), not by a
// standalone sync, since their `config.value` is a local path or an
// ephemeral upload with nothing to re-fetch from here.
//
// Every branch below writes back through `updateProjectSource` with either a
// successful `output`/`fetchedAt` or a `fetchError` explaining in words why
// it didn't - never throws, mirroring `refreshGithubSource`'s contract, so a
// re-sync click always resolves to a visible state instead of a 500.

import type { Db } from './db/client.js';
import { getProjectSource, updateProjectSource, type ProjectSourceRow } from './project-sources.js';
import { parseRepoUrl, README_EXCERPT_MAX_CHARS, type GithubFetch } from './github-sources.js';

export type SyncProjectSourceResult =
  { ok: true; source: ProjectSourceRow } | { ok: false; source: ProjectSourceRow };

export type SyncOptions = {
  /** Injectable fetch, defaults to the global one - tests substitute a mock
   * so this never actually reaches GitHub. */
  fetchImpl?: GithubFetch;
};

const GITHUB_API_BASE = 'https://api.github.com';

/** Same badge/HTML stripping `github-sources.ts` applies to a README before
 * it reaches a prompt - kept in step by hand since `excerptReadme` there is
 * module-private; see that file if the two ever need to diverge. */
function excerptReadme(raw: string): string {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
  const badges = /\[?!\[[^\]]*\]\([^)]*\)\]?(?:\([^)]*\))?/g;
  const htmlTags = /<\/?[a-zA-Z][^>]*>/g;
  const proseLines = withoutComments.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    const stripped = trimmed.replace(badges, '').replace(htmlTags, '');
    return /[a-z0-9]/i.test(stripped);
  });
  return proseLines
    .join('\n')
    .replace(htmlTags, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, README_EXCERPT_MAX_CHARS)
    .trim();
}

async function syncGithub(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
  fetchImpl: GithubFetch,
): Promise<SyncProjectSourceResult> {
  const rawConfig = source.config;
  const value =
    rawConfig &&
    typeof rawConfig === 'object' &&
    'value' in rawConfig &&
    typeof rawConfig.value === 'string'
      ? rawConfig.value
      : '';
  const parsed = parseRepoUrl(value);
  if (!parsed.ok) {
    const updated = await updateProjectSource(db, organizationId, source.id, {
      fetchedAt: new Date(),
      fetchError: parsed.reason,
    });
    return { ok: false, source: updated ?? source };
  }

  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const headers = { Accept: 'application/vnd.github+json' };

  let repoRes: Response;
  try {
    repoRes = await fetchImpl(base, { headers });
  } catch (err) {
    const updated = await updateProjectSource(db, organizationId, source.id, {
      fetchedAt: new Date(),
      fetchError: `network error: ${(err as Error).message}`,
    });
    return { ok: false, source: updated ?? source };
  }

  if (!repoRes.ok) {
    const reason =
      repoRes.status === 404
        ? 'repository not found (private or deleted)'
        : repoRes.status === 403
          ? 'GitHub API refused the request (403, likely the anonymous rate limit)'
          : `GitHub API returned ${repoRes.status}`;
    const updated = await updateProjectSource(db, organizationId, source.id, {
      fetchedAt: new Date(),
      fetchError: reason,
    });
    return { ok: false, source: updated ?? source };
  }

  const repoJson = (await repoRes.json()) as {
    description?: string | null;
    language?: string | null;
  };

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
    // Best-effort: the repo metadata above still lands without a README.
  }

  const updated = await updateProjectSource(db, organizationId, source.id, {
    output: {
      url: parsed.url,
      description: repoJson.description ?? null,
      primaryLanguage: repoJson.language ?? null,
      readmeExcerpt,
    },
    fetchedAt: new Date(),
    fetchError: null,
  });
  return { ok: true, source: updated ?? source };
}

async function markUnfetchable(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
  reason: string,
): Promise<SyncProjectSourceResult> {
  const updated = await updateProjectSource(db, organizationId, source.id, {
    fetchedAt: new Date(),
    fetchError: reason,
  });
  return { ok: false, source: updated ?? source };
}

/**
 * Fetches (or records why it can't fetch) one source. Returns null when `id`
 * does not exist or its project does not belong to `organizationId` - the
 * caller turns that into a 404, matching every other lookup in
 * `project-sources.ts`.
 */
export async function syncProjectSource(
  db: Db,
  organizationId: number,
  id: number,
  opts: SyncOptions = {},
): Promise<SyncProjectSourceResult | null> {
  const source = await getProjectSource(db, organizationId, id);
  if (!source) return null;

  switch (source.kind) {
    case 'github':
      return syncGithub(db, organizationId, source, opts.fetchImpl ?? fetch);
    case 'website':
    case 'linkedin_company':
    case 'linkedin_profile':
    case 'linkedin_post':
      return markUnfetchable(
        db,
        organizationId,
        source,
        `No fetcher is wired up for ${source.kind} sources yet.`,
      );
    case 'folder':
    case 'git':
    case 'upload':
      return markUnfetchable(
        db,
        organizationId,
        source,
        'This source is populated by running an extraction with it, not by re-syncing here - use "Run extraction" on this source instead.',
      );
    default:
      return markUnfetchable(db, organizationId, source, `Unknown source kind "${source.kind}".`);
  }
}
