import { api } from '../lib/api.js';
import { getSettings, setSettings } from '../lib/storage.js';

type InboxChild = {
  kind: string;
  data: {
    name?: string;
    author?: string;
    dest?: string;
    body?: string;
    parent_id?: string;
    context?: string;
    created_utc?: number;
    was_comment?: boolean;
  };
};

type InboxResponse = { data?: { children?: InboxChild[]; after?: string | null } };

// Reddit paginates the inbox listing; with no explicit limit it defaults to 25
// items, and even the max (100) isn't "everything". A backlog built up while
// the poller was down or disabled can span many pages - if only page 1 is
// ever fetched, the older items fall off it forever and are never seen by any
// future poll (silent, permanent loss). So we page backwards via the
// response's `after` cursor until we reach items at/before the last-synced
// cutoff or the inbox is exhausted, bounded by a page cap so a cutoff that can
// never be reached (e.g. no pairing has ever synced) can't page forever.
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

// Storage key for the inbox-side 429 backoff. Kept distinct from any chat-sync
// (Matrix) rate-limit key: the two pollers hit different Reddit endpoints and
// must not share a cooldown.
const INBOX_NOT_BEFORE_KEY = 'inboxNotBeforeAt';
const DEFAULT_RETRY_MS = 60_000;

function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    if (diff > 0) return diff;
  }
  return DEFAULT_RETRY_MS;
}

async function getInboxNotBeforeMs(): Promise<number> {
  const stored = await chrome.storage.local.get([INBOX_NOT_BEFORE_KEY]);
  const raw = (stored as Record<string, unknown>)[INBOX_NOT_BEFORE_KEY];
  if (typeof raw !== 'string') return 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function setInboxNotBeforeMs(atMs: number): Promise<void> {
  await chrome.storage.local.set({ [INBOX_NOT_BEFORE_KEY]: new Date(atMs).toISOString() });
}

function buildInboxUrl(after?: string): string {
  const url = new URL('https://www.reddit.com/message/inbox.json');
  url.searchParams.set('raw_json', '1');
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (after) url.searchParams.set('after', after);
  return url.toString();
}

export async function runInboxSync(): Promise<{
  ok: boolean;
  inserted?: number;
  replied?: number;
  reason?: string;
}> {
  try {
    const notBeforeMs = await getInboxNotBeforeMs();
    if (notBeforeMs > Date.now()) return { ok: false, reason: 'rate-limited' };

    // Multi-pairing: poll back as far as the OLDEST pairing's last sync,
    // so each backend sees every reply it's missed. api.dmSync de-dupes
    // by (account_handle, target_user, threadId) on the server.
    const { pairings } = await getSettings();
    const lastTimes = pairings
      .map((p) => (p.lastDmSyncAt ? new Date(p.lastDmSyncAt).getTime() : 0))
      .filter((t) => t > 0);
    const lastMs = lastTimes.length === pairings.length ? Math.min(...lastTimes) : 0;

    const allChildren: InboxChild[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(buildInboxUrl(after), {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'not-logged-in' };
      if (res.status === 429) {
        const retryMs = parseRetryAfterMs(res.headers.get('retry-after'));
        await setInboxNotBeforeMs(Date.now() + retryMs);
        return { ok: false, reason: 'http 429' };
      }
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      const data = (await res.json()) as InboxResponse;
      const children = data?.data?.children ?? [];
      allChildren.push(...children);

      const nextAfter = data?.data?.after ?? undefined;
      if (!nextAfter || children.length === 0) break;
      const oldestCreatedMs = Math.min(...children.map((c) => (c.data.created_utc ?? 0) * 1000));
      if (oldestCreatedMs <= lastMs) break;
      after = nextAfter;
    }

    const items: Array<{
      fromUser: string;
      toUser: string;
      body: string;
      threadId: string;
      createdAt: string;
    }> = [];
    const comments: Array<{
      parentCommentId: string;
      replyCommentId: string;
      author: string;
      body: string;
      createdAt: string;
      contextUrl: string;
    }> = [];

    for (const c of allChildren) {
      const createdMs = (c.data.created_utc ?? 0) * 1000;
      if (createdMs <= lastMs) continue;
      if (c.kind === 't4' && !c.data.was_comment) {
        items.push({
          fromUser: c.data.author ?? '',
          toUser: c.data.dest ?? '',
          body: c.data.body ?? '',
          threadId: c.data.name ?? '',
          createdAt: new Date(createdMs).toISOString(),
        });
      } else if (c.kind === 't1' && c.data.was_comment) {
        comments.push({
          parentCommentId: c.data.parent_id ?? '',
          replyCommentId: c.data.name ?? '',
          author: c.data.author ?? '',
          body: c.data.body ?? '',
          createdAt: new Date(createdMs).toISOString(),
          contextUrl: c.data.context ?? '',
        });
      }
    }

    if (items.length === 0 && comments.length === 0) {
      // Bump every pairing's lastDmSyncAt so the next poll narrows again.
      const now = new Date().toISOString();
      const { pairings: ps } = await getSettings();
      await setSettings({ pairings: ps.map((p) => ({ ...p, lastDmSyncAt: now })) });
      return { ok: true, inserted: 0, replied: 0 };
    }

    // api.dmSync fans out and stamps each pairing's lastDmSyncAt on success.
    const results = await api.dmSync('reddit', items, comments);
    if (results.length === 0) return { ok: false, reason: 'not configured' };
    const successes = results.filter((r) => r.ok);
    if (successes.length === 0) {
      const first = results[0];
      // #178: a 401 means the backend rejected our bearer token (e.g. the
      // extension device was revoked in Settings) - surface a distinct reason
      // so classifyInbox (background.ts) buckets it as 'unauthorized' instead
      // of a generic error, mirroring classifyChat's handling of a Matrix
      // 401/403.
      if (!first.ok && first.status === 401) return { ok: false, reason: 'device-revoked' };
      return { ok: false, reason: !first.ok ? first.error : 'unknown' };
    }
    const inserted = successes.reduce(
      (acc, r) => acc + (r.ok ? r.data.inserted + (r.data.commentsInserted ?? 0) : 0),
      0,
    );
    const replied = successes.reduce(
      (acc, r) => acc + (r.ok ? r.data.replied + (r.data.commentsReplied ?? 0) : 0),
      0,
    );
    return { ok: true, inserted, replied };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
