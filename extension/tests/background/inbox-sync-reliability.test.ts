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
    pairings: [
      {
        backendUrl: 'http://127.0.0.1:5180',
        token: 'x'.repeat(64),
        lastDmSyncAt: new Date('2026-04-24T08:00:00Z').toISOString(),
        consentAckAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  vi.restoreAllMocks();
});

async function importModule() {
  return await import('../../src/background/inbox-sync.js');
}

function inboxChild(opts: { name: string; createdAt: string }) {
  return {
    kind: 't4',
    data: {
      name: opts.name,
      author: 'a',
      dest: 'me',
      body: opts.name,
      created_utc: new Date(opts.createdAt).getTime() / 1000,
    },
  };
}

describe('runInboxSync pagination (#180)', () => {
  it('follows the after cursor to a second page when the first page is fully newer than lastMs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('inbox.json')) {
        if (u.includes('after=cursor_1')) {
          // Second page: still newer than lastMs (08:00), exhausted (no `after`).
          return new Response(
            JSON.stringify({
              data: {
                children: [inboxChild({ name: 't4_page2', createdAt: '2026-04-24T09:30:00Z' })],
                after: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // First page: one item newer than lastMs, more pages available.
        return new Response(
          JSON.stringify({
            data: {
              children: [inboxChild({ name: 't4_page1', createdAt: '2026-04-24T11:00:00Z' })],
              after: 'cursor_1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, inserted: 2, replied: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runInboxSync } = await importModule();
    const r = await runInboxSync();
    expect(r.ok).toBe(true);

    const inboxCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('inbox.json'));
    expect(inboxCalls).toHaveLength(2);
    expect(String(inboxCalls[1][0])).toContain('after=cursor_1');

    const postCall = (fetchMock.mock.calls as unknown as unknown[][]).find((c) =>
      String(c[0]).endsWith('/dm-sync'),
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { threadId: string }) => i.threadId)).toEqual([
      't4_page1',
      't4_page2',
    ]);
  });

  it('stops paging once the oldest item on a page is at/before lastMs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('inbox.json')) {
        if (u.includes('after=')) {
          throw new Error('should not page further once the cutoff is reached');
        }
        return new Response(
          JSON.stringify({
            data: {
              children: [
                inboxChild({ name: 't4_new', createdAt: '2026-04-24T11:00:00Z' }),
                // Oldest item on this page is already at/before lastMs (08:00),
                // so pagination must not continue even though `after` is set.
                inboxChild({ name: 't4_old', createdAt: '2026-04-24T07:00:00Z' }),
              ],
              after: 'cursor_1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, inserted: 1, replied: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runInboxSync } = await importModule();
    const r = await runInboxSync();
    expect(r.ok).toBe(true);

    const inboxCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('inbox.json'));
    expect(inboxCalls).toHaveLength(1);

    const postCall = (fetchMock.mock.calls as unknown as unknown[][]).find((c) =>
      String(c[0]).endsWith('/dm-sync'),
    );
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].threadId).toBe('t4_new');
  });
});

describe('runInboxSync 429 handling (#188)', () => {
  it('persists a not-before cutoff from Retry-After and short-circuits the next call', async () => {
    const firstFetch = vi.fn(async (url: string) => {
      if (String(url).includes('inbox.json')) {
        return new Response('', { status: 429, headers: { 'retry-after': '120' } });
      }
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', firstFetch);

    const { runInboxSync } = await importModule();
    const r1 = await runInboxSync();
    expect(r1).toEqual({ ok: false, reason: 'http 429' });
    expect(firstFetch).toHaveBeenCalledTimes(1);

    // A second call within the Retry-After window must not hit the network
    // at all: it should short-circuit off the persisted not-before cutoff.
    const secondFetch = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', secondFetch);

    const r2 = await runInboxSync();
    expect(r2).toEqual({ ok: false, reason: 'rate-limited' });
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('falls back to a default backoff when Retry-After is missing, still short-circuiting the next call', async () => {
    const firstFetch = vi.fn(async (url: string) => {
      if (String(url).includes('inbox.json')) return new Response('', { status: 429 });
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', firstFetch);

    const { runInboxSync } = await importModule();
    const r1 = await runInboxSync();
    expect(r1).toEqual({ ok: false, reason: 'http 429' });

    const secondFetch = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', secondFetch);

    const r2 = await runInboxSync();
    expect(r2).toEqual({ ok: false, reason: 'rate-limited' });
    expect(secondFetch).not.toHaveBeenCalled();
  });
});
