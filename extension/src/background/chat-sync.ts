import { api } from '../lib/api.js';
import { getSettings, setSettings } from '../lib/storage.js';
import { logEvent } from '../lib/activity.js';

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
  // `limited: true` means the homeserver capped this room's events to our
  // `timeline.limit` filter (30, see FILTER below) and dropped the overflow -
  // see #192 for where this is surfaced.
  timeline?: { events?: MatrixEvent[]; limited?: boolean };
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

// #175: bound on how many consecutive cycles we'll hold the Matrix cursor
// back while waiting for every paired backend to confirm delivery, before
// giving up on whichever pairing is stuck and advancing anyway (a dead
// pairing would otherwise wedge chat ingestion forever).
const MAX_CURSOR_HOLD_CYCLES = 5;

// #188: fallback backoff when a 429 has no usable Retry-After header.
const DEFAULT_RATE_LIMIT_MS = 60_000;

function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RATE_LIMIT_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return delta;
  }
  return DEFAULT_RATE_LIMIT_MS;
}

type SyncResult = {
  ok: boolean;
  inserted?: number;
  replied?: number;
  reason?: string;
  chatStatus?: 'ok' | 'unauthorized' | 'error' | 'unknown';
};

// Cheap pre-flight: hit /whoami before the heavier /sync call. If the Matrix
// token has expired we surface it as a badge + paused state in the popup
// rather than letting the sync silently fail every 10 min.
export async function probeMatrixToken(token: string): Promise<'ok' | 'unauthorized' | 'error'> {
  try {
    const res = await fetch(`${HS}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return 'unauthorized';
    if (!res.ok) return 'error';
    return 'ok';
  } catch {
    return 'error';
  }
}

function setBadge(state: 'unauthorized' | 'ok'): void {
  try {
    if (state === 'unauthorized') {
      chrome.action?.setBadgeText?.({ text: '!' });
      chrome.action?.setBadgeBackgroundColor?.({ color: '#dc2626' });
    } else {
      chrome.action?.setBadgeText?.({ text: '' });
    }
  } catch {
    // Badge updates are best-effort (e.g. when running under tests without chrome.action).
  }
}

export async function runChatSync(): Promise<SyncResult> {
  // #174: the whole body is wrapped so an unexpected throw (e.g. `res.json()`
  // on a non-JSON 200 response) always resolves to a well-formed failure
  // result instead of escaping - callers (runAllSyncs, the message listener)
  // rely on that to never lose the other poller's results.
  try {
    const s = await getSettings();
    if (!s.matrixToken || !s.matrixUserId) return { ok: false, reason: 'no-matrix-creds' };

    // #188: honor a backoff window from a prior 429 before spending another
    // request on a host that already told us to slow down.
    if (s.matrixRateLimitedUntil && Date.parse(s.matrixRateLimitedUntil) > Date.now()) {
      return { ok: false, reason: 'matrix-rate-limited', chatStatus: 'unknown' };
    }

    // Liveness probe first.
    const probe = await probeMatrixToken(s.matrixToken);
    if (probe === 'unauthorized') {
      setBadge('unauthorized');
      return { ok: false, reason: 'matrix-token-invalid', chatStatus: 'unauthorized' };
    }
    if (probe === 'error') {
      return { ok: false, reason: 'matrix-whoami-error', chatStatus: 'error' };
    }
    setBadge('ok');

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
      return { ok: false, reason: (e as Error).message, chatStatus: 'error' };
    }
    if (res.status === 429) {
      const waitMs = parseRetryAfterMs(res.headers.get('retry-after'));
      await setSettings({ matrixRateLimitedUntil: new Date(Date.now() + waitMs).toISOString() });
      return { ok: false, reason: 'matrix-rate-limited', chatStatus: 'error' };
    }
    if (res.status === 401 || res.status === 403) {
      setBadge('unauthorized');
      return { ok: false, reason: 'matrix-token-invalid', chatStatus: 'unauthorized' };
    }
    if (!res.ok) return { ok: false, reason: `matrix http ${res.status}`, chatStatus: 'error' };

    const data = (await res.json()) as SyncResponse;
    const joins = data.rooms?.join ?? {};

    // #192: the /sync filter caps each room's timeline to 30 events (see
    // FILTER above). When the homeserver reports `limited: true` it dropped
    // the overflow and we only ever see the newest 30 events - a full fix
    // needs an incremental /messages backfill per room (out of scope here),
    // so just make the gap observable.
    for (const [roomId, room] of Object.entries(joins)) {
      if (room.timeline?.limited) {
        await logEvent({
          level: 'warn',
          source: 'chat-sync',
          message: 'activity.chat-sync.timeline-truncated',
          messageParams: { roomId },
        });
      }
    }

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
      roomId: string;
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
          roomId,
        });
      }
    }

    // Don't commit the cursor yet: if delivery to every paired backend fails
    // below, the next /sync must be able to replay this batch, which only
    // works if `since` wasn't already advanced past it.
    const persistCursor = () =>
      setSettings({
        matrixSince: data.next_batch,
        matrixDisplayNames: displayNames,
        matrixRoomMembers: roomMembers,
        matrixCursorHoldCount: 0,
      });

    if (items.length === 0) {
      const heldCycles = s.matrixCursorHoldCount ?? 0;
      if (heldCycles === 0) {
        // Not holding anything: nothing to deliver this cycle and no prior
        // batch pending, so advancing is safe (mirrors inbox-sync bumping its
        // cursor on an empty poll).
        await persistCursor();
        return { ok: true, inserted: 0, replied: 0, chatStatus: 'ok' };
      }
      // We are mid-hold: a prior cycle's batch is still undelivered to some
      // pairing but did NOT reappear in this cycle's items - e.g. the room was
      // filtered out by a membership change, or the held events fell out of the
      // 30-event window (#192). Advancing here would silently drop the held
      // batch, so keep holding; give up VISIBLY after MAX cycles rather than
      // wedging ingestion forever.
      const next = heldCycles + 1;
      if (next < MAX_CURSOR_HOLD_CYCLES) {
        await setSettings({ matrixCursorHoldCount: next });
        return { ok: false, reason: 'holding-undelivered-batch', chatStatus: 'ok' };
      }
      await logEvent({
        level: 'warn',
        source: 'chat-sync',
        message: 'activity.chat-sync.cursor-skip',
        messageParams: { cycles: MAX_CURSOR_HOLD_CYCLES },
      });
      await persistCursor();
      return { ok: true, inserted: 0, replied: 0, chatStatus: 'ok' };
    }

    // Fan-out to every paired backend; aggregate counts and take the worst
    // outcome as the channel status (any backend failing surfaces a warning).
    const results = await api.dmSync('reddit', items);
    if (results.length === 0) return { ok: false, reason: 'not configured', chatStatus: 'ok' };
    const successes = results.filter((r) => r.ok);
    if (successes.length === 0) {
      // No pairing confirmed delivery: leave matrixSince untouched so the next
      // sync re-fetches and re-delivers this same batch.
      const first = results.find((r) => !r.ok);
      return {
        ok: false,
        reason: first && !first.ok ? first.error : 'unknown',
        chatStatus: 'ok',
      };
    }
    if (successes.length < results.length) {
      // #175: not every paired backend confirmed delivery. Advancing now
      // would permanently lose this batch for whichever pairing failed
      // (unlike inbox-sync, which recomputes its fetch floor as the MIN
      // lastDmSyncAt across pairings). Hold the cursor so the whole batch
      // replays next tick for every pairing - server-side dedupe on
      // threadId makes resending to the already-successful pairing safe -
      // but only for a bounded number of cycles, so a genuinely dead
      // pairing can't wedge chat ingestion forever.
      const holdCount = (s.matrixCursorHoldCount ?? 0) + 1;
      if (holdCount < MAX_CURSOR_HOLD_CYCLES) {
        await setSettings({ matrixCursorHoldCount: holdCount });
        const failed = results.find((r) => !r.ok);
        return {
          ok: false,
          reason: failed && !failed.ok ? failed.error : 'partial-delivery',
          chatStatus: 'ok',
        };
      }
      // Held for long enough: give up on whichever pairing is stuck and
      // advance anyway rather than wedging ingestion forever.
      await logEvent({
        level: 'warn',
        source: 'chat-sync',
        message: 'activity.chat-sync.cursor-skip',
        messageParams: { cycles: MAX_CURSOR_HOLD_CYCLES },
      });
    }
    await persistCursor();
    const inserted = successes.reduce((acc, r) => acc + (r.ok ? r.data.inserted : 0), 0);
    const replied = successes.reduce((acc, r) => acc + (r.ok ? r.data.replied : 0), 0);
    return { ok: true, inserted, replied, chatStatus: 'ok' };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, chatStatus: 'error' };
  }
}
