// Fetches (or explains why it can't fetch) one project source's content
// (#432). A project source's `config`/`output`/`fetch_error` shape is
// generic across all `PROJECT_SOURCE_KINDS` (project-sources.ts). Real
// fetchers are wired up for `git`, `website` (#472), `mastodon_account`
// and `hackernews_author` (#437). `linkedin_company` has none yet (#435's
// spike - the selector work is unstarted). `linkedin_post`/`linkedin_profile`
// have no fetcher here either, on purpose and permanently: docs/linkedin-integration-design.md's
// "Plane 3" decided the only lawful fill is the extension's own content
// script reading a page the human actually opened
// (extension/src/content/linkedin-source-capture.ts,
// shared/src/project-source-match.ts) - a server-side fetch of linkedin.com
// is rule 4 of the compliance boundary. A re-sync click on one of those two
// kinds can therefore only flip an already-filled row back to pending, never
// fetch anything itself - see `resetLinkedInSourceToPending` below.
// `folder`/`upload` name a path on the machine running Pitchbox: a
// description run reads them directly, so there is nothing for a sync to
// fetch and the re-sync says so instead of failing.
//
// `git` is the one kind whose sync picks its own mechanism (`syncGit`): the
// GitHub API for a GitHub URL, `git ls-remote` for any other host. It used
// to be two kinds, `git` and `github`, which was one thing wearing two
// names - see `PROJECT_SOURCE_KINDS`.
//
// Every branch below writes back through `updateProjectSource` (directly,
// for `git`) or through the kind's own `refresh*Source` (which does its
// own `updateProjectSource` internally, for `website`/`mastodon_account`/
// `hackernews_author`) with either a successful `output`/`fetchedAt` or a
// `fetchError` explaining in words why it didn't - never throws, so a
// re-sync click always resolves to a visible state instead of a 500.

import type { Db } from './db/client.js';
import { getProjectSource, updateProjectSource, type ProjectSourceRow } from './project-sources.js';
import { parseRepoUrl, README_EXCERPT_MAX_CHARS, type GithubFetch } from './github-sources.js';
import { lsRemoteBranches, type GitLsRemote } from './project-extraction/git-remote.js';
import { refreshWebsiteSource, type WebsiteFetch } from './website-source.js';
import { refreshMastodonAccountSource } from './mastodon-source.js';
import type { MastodonPublicFetch } from './platforms/mastodon/client.js';
import { refreshHackernewsAuthorSource, type HackernewsRawFetch } from './hackernews-source.js';

export type SyncProjectSourceResult =
  { ok: true; source: ProjectSourceRow } | { ok: false; source: ProjectSourceRow };

export type SyncOptions = {
  /** Injectable fetch for a GitHub-hosted `git` source - tests substitute a
   * mock so this never actually reaches GitHub. */
  fetchImpl?: GithubFetch;
  /** Injectable `git ls-remote` for a `git` source on any other host, so a
   * suite never spawns git or reaches a real remote. */
  gitLsRemoteImpl?: GitLsRemote;
  /** Injectable fetch for `website` - see `WebsiteCrawlOptions.fetchImpl`. */
  websiteFetchImpl?: WebsiteFetch;
  /** Injectable fetch for `mastodon_account` - see
   * `fetchPublicAccountStatuses`'s `fetchImpl`. */
  mastodonFetchImpl?: MastodonPublicFetch;
  /** Injectable fetch for `hackernews_author` - see
   * `HackernewsAuthorSourceOptions.fetchImpl`. */
  hackernewsFetchImpl?: HackernewsRawFetch;
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

/**
 * A repository source's URL. `config.value` is what the sources panel and
 * the CLI write; `config.url` is what migration 0018 wrote for the rows it
 * built out of `github_sources`, so both are read here rather than trusting
 * one era's shape.
 */
function readRepoUrl(source: ProjectSourceRow): string {
  const config = source.config;
  if (!config || typeof config !== 'object') return '';
  const record = config as Record<string, unknown>;
  for (const key of ['value', 'url']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * A repository source. There used to be two kinds for this - `git` (a clone
 * URL) and `github` (the same repository through the API) - and a person
 * adding "my repo" had to guess which one the product would read. One kind
 * now, with the mechanism chosen from the URL: GitHub gets the API read,
 * which costs no clone and leaves a README excerpt on the row for a
 * description run that cannot clone the tree, and every other host gets a
 * `git ls-remote`, which is the only thing a re-sync can honestly assert
 * where we have no API. Either way the tree itself is read by cloning,
 * during a description run.
 */
async function syncGit(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
  opts: SyncOptions,
): Promise<SyncProjectSourceResult> {
  const value = readRepoUrl(source);
  if (!value) {
    return markUnfetchable(db, organizationId, source, 'This source carries no repository URL.');
  }
  const parsed = parseRepoUrl(value);
  if (parsed.ok) {
    return syncGithubRepo(db, organizationId, source, parsed, opts.fetchImpl ?? fetch);
  }
  return syncGitRemote(db, organizationId, source, value, opts.gitLsRemoteImpl ?? lsRemoteBranches);
}

/** Proves a non-GitHub remote is readable and records what it advertises.
 * `ls-remote` transfers no objects, so this stays cheap enough for a button
 * a person clicks while watching. */
async function syncGitRemote(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
  url: string,
  lsRemote: GitLsRemote,
): Promise<SyncProjectSourceResult> {
  let branches: string[];
  try {
    branches = (await lsRemote(url)).branches;
  } catch (err) {
    return markUnfetchable(db, organizationId, source, (err as Error).message);
  }
  const updated = await updateProjectSource(db, organizationId, source.id, {
    output: { url, branchCount: branches.length, branches: branches.slice(0, 20) },
    fetchedAt: new Date(),
    fetchError: null,
  });
  return { ok: true, source: updated ?? source };
}

async function syncGithubRepo(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
  parsed: { owner: string; repo: string; url: string },
  fetchImpl: GithubFetch,
): Promise<SyncProjectSourceResult> {
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

/** Refreshes a source through one of the `refresh*Source` modules (which do
 * their own `updateProjectSource` internally) and reloads the row to report
 * `ok`/`fetchError` back - the shared shape `website`/`mastodon_account`/
 * `hackernews_author` all need, so one helper rather than three copies. */
async function syncViaRefresh(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
  refresh: () => Promise<void>,
): Promise<SyncProjectSourceResult> {
  await refresh();
  const updated = await getProjectSource(db, organizationId, source.id);
  if (!updated) return { ok: false, source };
  return { ok: updated.fetchError === null, source: updated };
}

/**
 * `linkedin_post`/`linkedin_profile` re-sync (#436, spike #435): there is no
 * server-side fetcher to run for either kind, and there never will be - the
 * only lawful fill is the extension's content script reading a page the
 * human actually opened (docs/linkedin-integration-design.md, "Plane 3").
 * A re-sync click here can only flip an already-filled row back to pending -
 * `output`/`fetchedAt`/`fetchError` all cleared - so the next real visit to
 * that URL fills it again through `fillProjectSourceFromCapture`
 * (project-source-match.ts). `ok` is false because nothing was fetched just
 * now, not because anything failed - a caller must not render this as an
 * error the way it renders a real `fetchError`.
 */
async function resetLinkedInSourceToPending(
  db: Db,
  organizationId: number,
  source: ProjectSourceRow,
): Promise<SyncProjectSourceResult> {
  const updated = await updateProjectSource(db, organizationId, source.id, {
    output: null,
    fetchedAt: null,
    fetchError: null,
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
    case 'git':
      return syncGit(db, organizationId, source, opts);
    case 'website':
      return syncViaRefresh(db, organizationId, source, () =>
        refreshWebsiteSource(db, source.id, { fetchImpl: opts.websiteFetchImpl }),
      );
    case 'mastodon_account':
      return syncViaRefresh(db, organizationId, source, () =>
        refreshMastodonAccountSource(db, source.id, { fetchImpl: opts.mastodonFetchImpl }),
      );
    case 'hackernews_author':
      return syncViaRefresh(db, organizationId, source, () =>
        refreshHackernewsAuthorSource(db, source.id, { fetchImpl: opts.hackernewsFetchImpl }),
      );
    case 'linkedin_company':
      return markUnfetchable(
        db,
        organizationId,
        source,
        `No fetcher is wired up for ${source.kind} sources yet.`,
      );
    case 'linkedin_post':
    case 'linkedin_profile':
      return resetLinkedInSourceToPending(db, organizationId, source);
    case 'folder':
    case 'upload':
      return markUnfetchable(
        db,
        organizationId,
        source,
        'This source is a path on the machine running Pitchbox, so there is nothing to re-fetch from here: it is read again the next time the description is regenerated.',
      );
    default:
      return markUnfetchable(db, organizationId, source, `Unknown source kind "${source.kind}".`);
  }
}
