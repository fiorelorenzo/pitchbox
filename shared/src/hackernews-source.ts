// An HN author's own submissions as a project source (#437): reuses the
// same Firebase HN adapter `fetchListings` already talks to
// (shared/src/platforms/hackernews/client.ts's `fetchUserSubmissions`, added
// alongside this file), so a project can cite what someone has actually
// posted on HN without a second HTTP client or a credential - HN has no
// auth API for reads anyway (see platforms/hackernews/account.ts).
//
// Follows website-source.ts's shape exactly: a cap on how much is fetched, a
// timeout on the network call, and a failure recorded on this source's own
// `fetch_error` rather than thrown at the project - a project with several
// sources and one rate-limited/unreachable one still reads.
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { createProjectSource, type ProjectSourceRow } from './project-sources.js';
import {
  fetchUserSubmissions,
  HN_AUTHOR_MAX_ITEMS,
  type Fetcher,
} from './platforms/hackernews/client.js';
import type { HnItem } from './platforms/hackernews/types.js';
import { extractPageText } from './website-source.js';

/** Per-request budget for both the `/user/:x.json` lookup and every
 * `/item/:id.json` hydration - mirrors `WEBSITE_FETCH_TIMEOUT_MS`. */
export const HACKERNEWS_FETCH_TIMEOUT_MS = 8_000;

/** Clamp on the combined text actually stored on the source row - what a
 * prompt reads, not an archive of everything the author has ever posted. */
export const HACKERNEWS_MAX_TEXT_CHARS = 20_000;

const HN_USERNAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

/** What this module needs to fetch a URL: the same minimal shape
 * website-source.ts's `WebsiteFetch` uses - an injectable `fetch` a test can
 * point at a fixture server instead of the real HN API. */
export type HackernewsRawFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

/** Wraps a raw `fetch` into the HN client's `Fetcher` shape
 * (`(url) => Promise<unknown>`), adding the per-request timeout the client
 * itself has no opinion on - same split as `crawlWebsite`/`fetchCapped` in
 * website-source.ts: the platform client is a bare network primitive, the
 * source module owns the cap/timeout policy. */
function timedFetcher(fetchImpl: HackernewsRawFetch, timeoutMs: number): Fetcher {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted)
          throw new Error(`timed out after ${timeoutMs}ms`, { cause: err });
        throw new Error(`network error: ${(err as Error).message}`, { cause: err });
      }
      if (!res.ok) throw new Error(`HN API ${res.status} for ${url}`);
      try {
        return await res.json();
      } catch (err) {
        if (controller.signal.aborted)
          throw new Error(`timed out after ${timeoutMs}ms`, { cause: err });
        throw new Error(`network error: ${(err as Error).message}`, { cause: err });
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Parses a bare HN username ("pg") or a profile URL
 * ("https://news.ycombinator.com/user?id=pg") into the username alone.
 * Rejects anything else - a story/item URL is not a profile. */
export function parseHackernewsUsername(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)ycombinator\.com$/.test(url.hostname)) return null;
    if (url.pathname !== '/user') return null;
    const id = url.searchParams.get('id');
    return id && HN_USERNAME_RE.test(id) ? id : null;
  } catch {
    return HN_USERNAME_RE.test(trimmed) ? trimmed : null;
  }
}

export interface HackernewsAuthorSourceOptions {
  /** Injectable fetch, defaults to the global one. Tests substitute a real
   * fixture server rather than a mock, so the timeout depends on real
   * network behaviour rather than a stubbed clock. */
  fetchImpl?: HackernewsRawFetch;
  timeoutMs?: number;
  limit?: number;
}

/** The `output` jsonb shape for a `hackernews_author` `project_sources` row. */
export interface HackernewsAuthorSourceOutput {
  username: string;
  posts: Array<{
    id: number;
    title: string;
    url: string | null;
    itemUrl: string;
    text: string | null;
  }>;
  /** Every post's title/url/text joined, clamped to `HACKERNEWS_MAX_TEXT_CHARS`. */
  text: string;
  fetchedPostCount: number;
}

function postSnippet(item: HnItem): string {
  const parts = [item.title];
  if (item.url) parts.push(item.url);
  if (item.text) parts.push(extractPageText(item.text));
  return parts.join('\n');
}

/**
 * Refreshes one `hackernews_author` source's cached submissions
 * unconditionally. Never throws: a lookup/hydration failure (unknown user,
 * a rate limit, a network error, a timeout) becomes this row's own
 * `fetch_error`, leaving whatever `output` it last carried untouched -
 * mirrors `refreshWebsiteSource`.
 */
export async function refreshHackernewsAuthorSource(
  db: Db,
  id: number,
  opts: HackernewsAuthorSourceOptions = {},
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, id));
  if (!row || row.kind !== 'hackernews_author') return;

  const config = row.config as { username?: unknown };
  const username = typeof config.username === 'string' ? config.username : '';
  if (!username) {
    await db
      .update(schema.projectSources)
      .set({
        fetchError: 'source has no username configured',
        fetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.projectSources.id, id));
    return;
  }

  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? HACKERNEWS_FETCH_TIMEOUT_MS;
  const limit = Math.max(1, Math.min(opts.limit ?? HN_AUTHOR_MAX_ITEMS, HN_AUTHOR_MAX_ITEMS));

  let items: HnItem[];
  try {
    items = await fetchUserSubmissions(username, { limit }, timedFetcher(fetchImpl, timeoutMs));
  } catch (err) {
    await db
      .update(schema.projectSources)
      .set({ fetchError: (err as Error).message, fetchedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.projectSources.id, id));
    return;
  }

  const posts = items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    itemUrl: item.itemUrl,
    text: item.text,
  }));
  const joinedText = items.map(postSnippet).join('\n\n---\n\n');
  const output: HackernewsAuthorSourceOutput = {
    username,
    posts,
    text:
      joinedText.length > HACKERNEWS_MAX_TEXT_CHARS
        ? joinedText.slice(0, HACKERNEWS_MAX_TEXT_CHARS)
        : joinedText,
    fetchedPostCount: posts.length,
  };

  await db
    .update(schema.projectSources)
    .set({ output, fetchError: null, fetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.projectSources.id, id));
}

export type AddHackernewsAuthorSourceResult =
  | { ok: true; source: ProjectSourceRow }
  | { ok: false; code: 'invalid_username'; reason: string }
  | { ok: false; code: 'not_found' };

/**
 * Adds an HN author source to a project and does its first fetch inline, so
 * the caller gets back a source that already has posts (or already has its
 * error) rather than an empty row - mirrors `addWebsiteSource`.
 */
export async function addHackernewsAuthorSource(
  db: Db,
  organizationId: number,
  projectId: number,
  input: string,
  opts: HackernewsAuthorSourceOptions = {},
): Promise<AddHackernewsAuthorSourceResult> {
  const username = parseHackernewsUsername(input);
  if (!username) {
    return {
      ok: false,
      code: 'invalid_username',
      reason: 'not a valid Hacker News username or profile URL',
    };
  }

  const created = await createProjectSource(db, organizationId, projectId, 'hackernews_author', {
    username,
  });
  if (!created) return { ok: false, code: 'not_found' };

  await refreshHackernewsAuthorSource(db, created.id, opts);

  const [fresh] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, created.id));
  return { ok: true, source: fresh ?? created };
}
