// A Mastodon account's own public posts as a project source (#437): reuses
// the Mastodon adapter's types (shared/src/platforms/mastodon/types.ts) and
// a new unauthenticated read (`fetchPublicAccountStatuses`,
// shared/src/platforms/mastodon/client.ts) rather than the credentialed
// `MastodonClient` this repo already has for posting/notifications on a
// *connected account's* behalf - reading an arbitrary external profile's
// public posts needs no credential and shouldn't spend one.
//
// Follows website-source.ts's shape exactly: a cap on how much is fetched, a
// timeout on the network call, and a failure recorded on this source's own
// `fetch_error` rather than thrown at the project.
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { createProjectSource, type ProjectSourceRow } from './project-sources.js';
import {
  fetchPublicAccountStatuses,
  type MastodonPublicFetch,
  type PublicAccountStatuses,
} from './platforms/mastodon/client.js';
import { extractPageText } from './website-source.js';

/** Per-request budget for both the account lookup and the statuses read -
 * mirrors `WEBSITE_FETCH_TIMEOUT_MS`. */
export const MASTODON_FETCH_TIMEOUT_MS = 8_000;

/** Default (and max) number of an account's own recent posts a source keeps. */
export const MASTODON_MAX_POSTS = 10;

/** Clamp on the combined text actually stored on the source row. */
export const MASTODON_MAX_TEXT_CHARS = 20_000;

/**
 * Parses a Mastodon profile URL ("https://instance.social/@user") into its
 * instance origin and handle. Rejects anything that isn't that exact shape -
 * a status permalink or a hashtag page is not a profile.
 */
export function parseMastodonProfileUrl(
  input: string,
): { instanceUrl: string; acct: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const match = /^\/@([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  return { instanceUrl: url.origin, acct: decodeURIComponent(match[1]) };
}

export interface MastodonAccountSourceOptions {
  /** Injectable fetch, defaults to the global one. Tests substitute a real
   * fixture server rather than a mock, so the timeout depends on real
   * network behaviour rather than a stubbed clock. */
  fetchImpl?: MastodonPublicFetch;
  timeoutMs?: number;
  limit?: number;
}

/** The `output` jsonb shape for a `mastodon_account` `project_sources` row. */
export interface MastodonAccountSourceOutput {
  instanceUrl: string;
  acct: string;
  displayName: string;
  posts: Array<{ id: string; url: string | null; createdAt: string; text: string }>;
  /** Every post's plain text, joined and clamped to `MASTODON_MAX_TEXT_CHARS`. */
  text: string;
  fetchedPostCount: number;
}

/**
 * Refreshes one `mastodon_account` source's cached posts unconditionally.
 * Never throws: a lookup failure (unknown handle, a rate limit, a network
 * error, a timeout) becomes this row's own `fetch_error`, leaving whatever
 * `output` it last carried untouched - mirrors `refreshWebsiteSource`.
 */
export async function refreshMastodonAccountSource(
  db: Db,
  id: number,
  opts: MastodonAccountSourceOptions = {},
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, id));
  if (!row || row.kind !== 'mastodon_account') return;

  const config = row.config as { instanceUrl?: unknown; acct?: unknown };
  const instanceUrl = typeof config.instanceUrl === 'string' ? config.instanceUrl : '';
  const acct = typeof config.acct === 'string' ? config.acct : '';
  if (!instanceUrl || !acct) {
    await db
      .update(schema.projectSources)
      .set({
        fetchError: 'source has no Mastodon account configured',
        fetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.projectSources.id, id));
    return;
  }

  let result: PublicAccountStatuses;
  try {
    result = await fetchPublicAccountStatuses(instanceUrl, acct, {
      limit: opts.limit ?? MASTODON_MAX_POSTS,
      timeoutMs: opts.timeoutMs ?? MASTODON_FETCH_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    await db
      .update(schema.projectSources)
      .set({ fetchError: (err as Error).message, fetchedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.projectSources.id, id));
    return;
  }

  const posts = result.statuses.map((status) => ({
    id: status.id,
    url: status.url,
    createdAt: status.created_at,
    text: extractPageText(status.content),
  }));
  const joinedText = posts.map((post) => post.text).join('\n\n---\n\n');
  const output: MastodonAccountSourceOutput = {
    instanceUrl,
    acct,
    displayName: result.account.display_name || result.account.username,
    posts,
    text:
      joinedText.length > MASTODON_MAX_TEXT_CHARS
        ? joinedText.slice(0, MASTODON_MAX_TEXT_CHARS)
        : joinedText,
    fetchedPostCount: posts.length,
  };

  await db
    .update(schema.projectSources)
    .set({ output, fetchError: null, fetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.projectSources.id, id));
}

export type AddMastodonAccountSourceResult =
  | { ok: true; source: ProjectSourceRow }
  | { ok: false; code: 'invalid_url'; reason: string }
  | { ok: false; code: 'not_found' };

/**
 * Adds a Mastodon account source to a project and does its first fetch
 * inline, so the caller gets back a source that already has posts (or
 * already has its error) rather than an empty row - mirrors
 * `addWebsiteSource`.
 */
export async function addMastodonAccountSource(
  db: Db,
  organizationId: number,
  projectId: number,
  profileUrl: string,
  opts: MastodonAccountSourceOptions = {},
): Promise<AddMastodonAccountSourceResult> {
  const parsed = parseMastodonProfileUrl(profileUrl);
  if (!parsed) {
    return {
      ok: false,
      code: 'invalid_url',
      reason: 'not a Mastodon profile URL (expected https://instance/@handle)',
    };
  }

  const created = await createProjectSource(db, organizationId, projectId, 'mastodon_account', {
    instanceUrl: parsed.instanceUrl,
    acct: parsed.acct,
  });
  if (!created) return { ok: false, code: 'not_found' };

  await refreshMastodonAccountSource(db, created.id, opts);

  const [fresh] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, created.id));
  return { ok: true, source: fresh ?? created };
}
