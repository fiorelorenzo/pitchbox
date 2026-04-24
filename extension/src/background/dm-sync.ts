import { api } from '../lib/api.js';
import { getSettings, setSettings } from '../lib/storage.js';

type InboxChild = {
  kind: string;
  data: {
    name?: string;
    author?: string;
    dest?: string;
    body?: string;
    created_utc?: number;
    was_comment?: boolean;
  };
};

type InboxResponse = {
  data?: { children?: InboxChild[] };
};

export async function runDmSync(): Promise<{
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

    const { lastDmSyncAt } = await getSettings();
    const lastMs = lastDmSyncAt ? new Date(lastDmSyncAt).getTime() : 0;

    const items = [];
    for (const c of children) {
      if (c.kind !== 't4') continue;
      if (c.data.was_comment) continue;
      const createdMs = (c.data.created_utc ?? 0) * 1000;
      if (createdMs <= lastMs) continue;
      items.push({
        fromUser: c.data.author ?? '',
        toUser: c.data.dest ?? '',
        body: c.data.body ?? '',
        threadId: c.data.name ?? '',
        createdAt: new Date(createdMs).toISOString(),
      });
    }

    if (items.length === 0) {
      await setSettings({ lastDmSyncAt: new Date().toISOString() });
      return { ok: true, inserted: 0, replied: 0 };
    }

    const r = await api.dmSync('reddit', items);
    await setSettings({ lastDmSyncAt: new Date().toISOString() });
    if (!r.ok) return { ok: false, reason: r.error };
    return { ok: true, inserted: r.data.inserted, replied: r.data.replied };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
