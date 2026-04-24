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
  };
  vi.restoreAllMocks();
});

async function importModule() {
  return await import('../../src/background/dm-sync.js');
}

describe('runDmSync', () => {
  it('returns not-logged-in when inbox returns 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    const { runDmSync } = await importModule();
    const r = await runDmSync();
    expect(r).toEqual({ ok: false, reason: 'not-logged-in' });
  });

  it('filters t1 items and items older than lastDmSyncAt', async () => {
    ((globalThis as any).chrome.storage.local as any)._s.lastDmSyncAt = new Date(
      '2026-04-24T10:00:00Z',
    ).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('inbox.json')) {
          return new Response(
            JSON.stringify({
              data: {
                children: [
                  {
                    kind: 't4',
                    data: {
                      name: 't4_new',
                      author: 'a',
                      dest: 'me',
                      body: 'hi',
                      created_utc: new Date('2026-04-24T11:00:00Z').getTime() / 1000,
                    },
                  },
                  {
                    kind: 't4',
                    data: {
                      name: 't4_old',
                      author: 'a',
                      dest: 'me',
                      body: 'old',
                      created_utc: new Date('2026-04-24T09:00:00Z').getTime() / 1000,
                    },
                  },
                  {
                    kind: 't1',
                    data: {
                      name: 't1_c',
                      author: 'a',
                      dest: 'me',
                      body: 'comment',
                      created_utc: new Date('2026-04-24T11:00:00Z').getTime() / 1000,
                      was_comment: true,
                    },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true, inserted: 1, replied: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { runDmSync } = await importModule();
    const r = await runDmSync();
    expect(r.ok).toBe(true);
    const postCall = (fetch as any).mock.calls.find((c: any[]) => c[0].endsWith('/dm-sync'));
    expect(postCall).toBeTruthy();
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.items).toHaveLength(1);
    expect(postBody.items[0].threadId).toBe('t4_new');
  });

  it('writes lastDmSyncAt even when there are zero new items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { children: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { runDmSync } = await importModule();
    const r = await runDmSync();
    expect(r).toMatchObject({ ok: true, inserted: 0 });
    const stored = ((globalThis as any).chrome.storage.local as any)._s;
    expect(stored.lastDmSyncAt).toBeTruthy();
  });
});
