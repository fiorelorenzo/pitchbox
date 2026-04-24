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
};

beforeEach(() => {
  ((globalThis as any).chrome.storage.local as any)._s = {
    backendUrl: 'http://127.0.0.1:5180',
    token: 'x'.repeat(64),
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

describe('runChatSync', () => {
  it('returns no-matrix-creds when token missing', async () => {
    delete ((globalThis as any).chrome.storage.local as any)._s.matrixToken;
    const { runChatSync } = await importModule();
    const r = await runChatSync();
    expect(r).toEqual({ ok: false, reason: 'no-matrix-creds' });
  });

  it('returns matrix-token-invalid on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    const { runChatSync } = await importModule();
    const r = await runChatSync();
    expect(r).toEqual({ ok: false, reason: 'matrix-token-invalid' });
  });

  it('extracts inbound + outbound DMs from a 2-person room and posts to backend', async () => {
    const sync = syncResponse({
      messages: [
        { sender: ME, body: 'ciao', eventId: '$ev1', ts: Date.parse('2026-04-24T11:00:00Z') },
        {
          sender: OTHER,
          body: 'rispondo',
          eventId: '$ev2',
          ts: Date.parse('2026-04-24T11:05:00Z'),
        },
      ],
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('matrix.redditspace.com')) {
        return new Response(JSON.stringify(sync), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, inserted: 2, replied: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runChatSync } = await importModule();
    const r = await runChatSync();
    expect(r).toMatchObject({ ok: true, inserted: 2, replied: 1 });

    const post = (fetchMock.mock.calls as unknown as unknown[][]).find((c) =>
      String(c[0]).endsWith('/dm-sync'),
    );
    expect(post).toBeTruthy();
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body.platform).toBe('reddit');
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      fromUser: 'fiorelorenzo',
      toUser: 'blamebauer',
      body: 'ciao',
      threadId: '$ev1',
    });
    expect(body.items[1]).toMatchObject({
      fromUser: 'blamebauer',
      toUser: 'fiorelorenzo',
      body: 'rispondo',
      threadId: '$ev2',
    });

    const stored = ((globalThis as any).chrome.storage.local as any)._s;
    expect(stored.matrixSince).toBe('s_next_123');
    expect(stored.matrixDisplayNames[ME]).toBe('fiorelorenzo');
    expect(stored.matrixRoomMembers[ROOM_ID]).toContain(OTHER);
  });

  it('skips group rooms (>2 members)', async () => {
    const third = '@t2_third:reddit.com';
    const sync = {
      next_batch: 's_next',
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
                {
                  type: 'm.room.member',
                  state_key: OTHER,
                  content: { displayname: 'other', membership: 'join' },
                },
                {
                  type: 'm.room.member',
                  state_key: third,
                  content: { displayname: 'third', membership: 'join' },
                },
              ],
            },
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: OTHER,
                  content: { body: 'hi', msgtype: 'm.text' },
                  event_id: '$x',
                  origin_server_ts: Date.now(),
                },
              ],
            },
          },
        },
      },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(sync), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { runChatSync } = await importModule();
    const r = await runChatSync();
    expect(r).toEqual({ ok: true, inserted: 0, replied: 0 });
    expect(
      (fetchMock.mock.calls as unknown as unknown[][]).find((c) =>
        String(c[0]).endsWith('/dm-sync'),
      ),
    ).toBeUndefined();
  });

  it('sends since= cursor on subsequent calls', async () => {
    ((globalThis as any).chrome.storage.local as any)._s.matrixSince = 's_prev_999';
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ next_batch: 's_after', rooms: { join: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { runChatSync } = await importModule();
    await runChatSync();
    const url = String((fetchMock.mock.calls as unknown as unknown[][])[0][0]);
    expect(url).toContain('since=s_prev_999');
    expect(url).not.toContain('full_state=true');
  });
});
