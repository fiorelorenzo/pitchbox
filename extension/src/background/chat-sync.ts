import { api } from '../lib/api.js';
import { getSettings, setSettings } from '../lib/storage.js';

const HS = 'https://matrix.redditspace.com';

type MatrixEvent = {
  type: string;
  sender?: string;
  state_key?: string;
  content?: {
    body?: string;
    displayname?: string;
    membership?: string;
    msgtype?: string;
  };
  event_id?: string;
  origin_server_ts?: number;
};

type SyncRoom = {
  timeline?: { events?: MatrixEvent[] };
  state?: { events?: MatrixEvent[] };
};

type SyncResponse = {
  next_batch: string;
  rooms?: { join?: Record<string, SyncRoom> };
};

// Reddit auto-joins this system account ("u/Reddit") into every chat room with
// no displayname; it would otherwise inflate member counts.
const REDDIT_SYSTEM_USER = '@t2_1qwk:reddit.com';

function isRealMember(userId: string, displayName: string | undefined): boolean {
  if (userId === REDDIT_SYSTEM_USER) return false;
  if (!displayName || displayName === 'undefined') return false;
  return true;
}

const FILTER = JSON.stringify({
  room: {
    timeline: { limit: 30, types: ['m.room.message'] },
    state: { types: ['m.room.member'] },
    ephemeral: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
});

type SyncResult = {
  ok: boolean;
  inserted?: number;
  replied?: number;
  reason?: string;
};

export async function runChatSync(): Promise<SyncResult> {
  const s = await getSettings();
  if (!s.matrixToken || !s.matrixUserId) return { ok: false, reason: 'no-matrix-creds' };

  const meId = s.matrixUserId;
  const since = s.matrixSince ?? '';
  const displayNames: Record<string, string> = { ...(s.matrixDisplayNames ?? {}) };
  const roomMembers: Record<string, string[]> = { ...(s.matrixRoomMembers ?? {}) };

  const url = new URL(`${HS}/_matrix/client/v3/sync`);
  url.searchParams.set('timeout', '0');
  url.searchParams.set('filter', FILTER);
  if (since) url.searchParams.set('since', since);
  else url.searchParams.set('full_state', 'true');

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${s.matrixToken}` },
    });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'matrix-token-invalid' };
  }
  if (!res.ok) return { ok: false, reason: `matrix http ${res.status}` };

  const data = (await res.json()) as SyncResponse;
  const joins = data.rooms?.join ?? {};

  // Update member + displayname caches.
  for (const [roomId, room] of Object.entries(joins)) {
    const allEvents = [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])];
    for (const ev of allEvents) {
      if (ev.type !== 'm.room.member' || !ev.state_key) continue;
      if (ev.content?.displayname) displayNames[ev.state_key] = ev.content.displayname;
      if (ev.content?.membership === 'join') {
        const list = roomMembers[roomId] ?? [];
        if (!list.includes(ev.state_key)) list.push(ev.state_key);
        roomMembers[roomId] = list;
      } else if (ev.content?.membership === 'leave' || ev.content?.membership === 'ban') {
        roomMembers[roomId] = (roomMembers[roomId] ?? []).filter((m) => m !== ev.state_key);
      }
    }
  }

  type DmItem = {
    fromUser: string;
    toUser: string;
    body: string;
    threadId: string;
    createdAt: string;
  };
  const items: DmItem[] = [];

  for (const [roomId, room] of Object.entries(joins)) {
    const allMembers = roomMembers[roomId] ?? [];
    const realMembers = allMembers.filter((m) => isRealMember(m, displayNames[m]));
    if (realMembers.length !== 2) continue; // skip group chats
    if (!realMembers.includes(meId)) continue;
    const otherId = realMembers.find((m) => m !== meId)!;
    const meHandle = displayNames[meId];
    const otherHandle = displayNames[otherId];
    if (!meHandle || !otherHandle) continue;

    for (const ev of room.timeline?.events ?? []) {
      if (ev.type !== 'm.room.message') continue;
      if (ev.content?.msgtype && ev.content.msgtype !== 'm.text') continue;
      const body = ev.content?.body;
      const sender = ev.sender;
      const eventId = ev.event_id;
      const ts = ev.origin_server_ts;
      if (!body || !sender || !eventId || !ts) continue;
      const fromUs = sender === meId;
      items.push({
        fromUser: fromUs ? meHandle : otherHandle,
        toUser: fromUs ? otherHandle : meHandle,
        body,
        threadId: eventId,
        createdAt: new Date(ts).toISOString(),
      });
    }
  }

  await setSettings({
    matrixSince: data.next_batch,
    matrixDisplayNames: displayNames,
    matrixRoomMembers: roomMembers,
  });

  if (items.length === 0) return { ok: true, inserted: 0, replied: 0 };

  const r = await api.dmSync('reddit', items);
  if (!r.ok) return { ok: false, reason: r.error };
  return { ok: true, inserted: r.data.inserted, replied: r.data.replied };
}
