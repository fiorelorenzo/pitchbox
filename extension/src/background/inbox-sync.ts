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

type InboxResponse = { data?: { children?: InboxChild[] } };

export async function runInboxSync(): Promise<{
  ok: boolean;
  inserted?: number;
  replied?: number;
  reason?: string;
}> {
  try {
    const res = await fetch('https://www.reddit.com/message/inbox.json?raw_json=1', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'not-logged-in' };
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const data = (await res.json()) as InboxResponse;
    const children = data?.data?.children ?? [];

    // Multi-pairing: poll back as far as the OLDEST pairing's last sync,
    // so each backend sees every reply it's missed. api.dmSync de-dupes
    // by (account_handle, target_user, threadId) on the server.
    const { pairings } = await getSettings();
    const lastTimes = pairings
      .map((p) => (p.lastDmSyncAt ? new Date(p.lastDmSyncAt).getTime() : 0))
      .filter((t) => t > 0);
    const lastMs = lastTimes.length === pairings.length ? Math.min(...lastTimes) : 0;

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

    for (const c of children) {
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
