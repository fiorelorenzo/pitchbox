import { describe, it, expect, vi, beforeEach } from 'vitest';

(globalThis as any).chrome = {
  storage: {
    local: {
      _s: {} as Record<string, unknown>,
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in (this._s as any)) out[k] = (this._s as any)[k];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(this._s as any, patch);
      },
    },
  },
  action: {
    setBadgeText: () => undefined,
    setBadgeBackgroundColor: () => undefined,
  },
};

beforeEach(() => {
  ((globalThis as any).chrome.storage.local as any)._s = {
    pairings: [{ backendUrl: 'http://127.0.0.1:5180', token: 'x'.repeat(64) }],
    matrixUserId: '@t2_me:reddit.com',
    matrixToken: 'mxtoken',
  };
  vi.restoreAllMocks();
});

async function importModule() {
  return await import('../../src/background/chat-sync.js');
}

const ROOM_ID = '!room1:reddit.com';
const ME = '@t2_me:reddit.com';
const OTHER = '@t2_other:reddit.com';

function syncResponse(opts: {
  messages: Array<{ sender: string; body: string; eventId: string; ts: number }>;
}) {
  return {
    next_batch: 's_next_123',
    rooms: {
      join: {
        [ROOM_ID]: {
          state: {
            events: [
              {
                type: 'm.room.member',
                state_key: ME,
                content: { displayname: 'fiorelorenzo', membership: 'join' },
              },
              {
                type: 'm.room.member',
                state_key: OTHER,
                content: { displayname: 'blamebauer', membership: 'join' },
              },
            ],
          },
          timeline: {
            events: opts.messages.map((m) => ({
              type: 'm.room.message',
              sender: m.sender,
              content: { body: m.body, msgtype: 'm.text' },
              event_id: m.eventId,
              origin_server_ts: m.ts,
            })),
          },
        },
      },
    },
  };
}

function whoamiOk() {
  return new Response(JSON.stringify({ user_id: ME }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runChatSync reliability (#174, #175, #188)', () => {
  it('#174: a 200 /sync response with a non-JSON body resolves ok:false instead of throwing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/whoami')) return whoamiOk();
      // Malformed 200: valid HTTP status, invalid JSON body.
      return new Response('<html>not json</html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runChatSync } = await importModule();
    await expect(runChatSync()).resolves.toMatchObject({
      ok: false,
      chatStatus: 'error',
    });
  });

  it('#175: does not advance matrixSince when one of several pairings fails delivery', async () => {
    ((globalThis as any).chrome.storage.local as any)._s.pairings = [
      { backendUrl: 'http://127.0.0.1:5180', token: 'x'.repeat(64) },
      { backendUrl: 'http://127.0.0.1:5181', token: 'y'.repeat(64) },
    ];
    const sync = syncResponse({
      messages: [
        { sender: ME, body: 'ciao', eventId: '$ev1', ts: Date.parse('2026-04-24T11:00:00Z') },
      ],
    });
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/whoami')) return whoamiOk();
      if (u.includes('matrix.redditspace.com')) {
        return new Response(JSON.stringify(sync), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.startsWith('http://127.0.0.1:5180')) {
        return new Response(JSON.stringify({ ok: true, inserted: 1, replied: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The second pairing is down.
      return new Response('down', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runChatSync } = await importModule();
    const r = await runChatSync();
    expect(r.ok).toBe(false);

    const stored = ((globalThis as any).chrome.storage.local as any)._s;
    // The healthy pairing already saw this batch, but the cursor must stay put
    // so the down pairing gets the same batch replayed next tick.
    expect(stored.matrixSince).toBeUndefined();
    expect(stored.matrixCursorHoldCount).toBe(1);
  });

  it('#175: an empty-items cycle while holding does NOT advance the cursor (keeps holding)', async () => {
    // A prior cycle held the cursor because a pairing failed delivery.
    ((globalThis as any).chrome.storage.local as any)._s.matrixCursorHoldCount = 1;
    // This cycle yields zero deliverable items (the room is no longer a
    // 2-member DM - the counterparty is gone), but the held batch is still
    // undelivered, so the cursor must NOT advance past it.
    const noItemsSync = {
      next_batch: 's_next_456',
      rooms: {
        join: {
          [ROOM_ID]: {
            state: {
              events: [
                {
                  type: 'm.room.member',
                  state_key: ME,
                  content: { displayname: 'me', membership: 'join' },
                },
              ],
            },
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: ME,
                  content: { body: 'hi', msgtype: 'm.text' },
                  event_id: '$x1',
                  origin_server_ts: Date.parse('2026-04-24T12:00:00Z'),
                },
              ],
            },
          },
        },
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/whoami')) return whoamiOk();
      if (u.includes('matrix.redditspace.com')) {
        return new Response(JSON.stringify(noItemsSync), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, inserted: 0, replied: 0 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runChatSync } = await importModule();
    const r = await runChatSync();
    expect(r.ok).toBe(false);

    const stored = ((globalThis as any).chrome.storage.local as any)._s;
    expect(stored.matrixSince).toBeUndefined();
    expect(stored.matrixCursorHoldCount).toBe(2);
  });

  it('#188: a 429 with Retry-After short-circuits the next call within the window', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/whoami')) return whoamiOk();
      if (u.includes('matrix.redditspace.com')) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runChatSync } = await importModule();
    const first = await runChatSync();
    expect(first).toMatchObject({ ok: false, reason: 'matrix-rate-limited', chatStatus: 'error' });

    const stored = ((globalThis as any).chrome.storage.local as any)._s;
    expect(stored.matrixRateLimitedUntil).toBeTruthy();
    expect(Date.parse(stored.matrixRateLimitedUntil as string)).toBeGreaterThan(Date.now());

    const callsBefore = fetchMock.mock.calls.length;
    const second = await runChatSync();
    expect(second).toMatchObject({
      ok: false,
      reason: 'matrix-rate-limited',
      chatStatus: 'unknown',
    });
    // Short-circuited before touching the network again.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
