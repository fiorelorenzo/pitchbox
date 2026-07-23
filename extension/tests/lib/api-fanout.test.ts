import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal chrome.storage.local mock so api.ts's getSettings()/patchPairing() resolve.
(globalThis as any).chrome = {
  storage: {
    local: {
      _s: {} as Record<string, unknown>,
      async get(keys: string[] | string) {
        const k = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const x of k) if (x in this._s) out[x] = this._s[x];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(this._s, patch);
      },
      async remove(keys: string[] | string) {
        const k = Array.isArray(keys) ? keys : [keys];
        for (const x of k) delete this._s[x];
      },
    },
  },
};

function seed(pairings: Array<{ backendUrl: string; token: string; consentAckAt?: string }>) {
  (globalThis as any).chrome.storage.local._s = { pairings };
}

beforeEach(() => {
  (globalThis as any).chrome.storage.local._s = {};
  vi.restoreAllMocks();
});

// Consented pairings (#186): delivery of message bodies is gated on consentAckAt.
const A = { backendUrl: 'https://a.example', token: 'ta', consentAckAt: '2026-01-01T00:00:00Z' };
const B = { backendUrl: 'https://b.example', token: 'tb', consentAckAt: '2026-01-01T00:00:00Z' };

describe('api.dmSync fan-out concurrency (#193)', () => {
  it('fires per-pairing POSTs concurrently and folds results back in pairing order', async () => {
    seed([A, B]);
    const { api } = await import('../../src/lib/api.js');

    const started: string[] = [];
    let resolveA!: (res: Response) => void;
    let resolveB!: (res: Response) => void;
    const pendingA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<Response>((resolve) => {
      resolveB = resolve;
    });

    const fetchMock = vi.fn((url: string) => {
      started.push(String(url));
      if (String(url).startsWith(A.backendUrl)) return pendingA;
      if (String(url).startsWith(B.backendUrl)) return pendingB;
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fanoutPromise = api.dmSync('reddit', [{ from: 'x' }]);

    // Both requests must already be in flight before either settles - if the
    // fan-out were still sequential, fetch for B would not be called until
    // A's promise resolves, and this would time out.
    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
    });
    expect(started).toEqual([
      `${A.backendUrl}/api/extension/dm-sync`,
      `${B.backendUrl}/api/extension/dm-sync`,
    ]);

    // Resolve out of pairing order (B before A) to prove the returned
    // fan-out order follows the pairing list, not settlement order.
    resolveB(new Response(JSON.stringify({ ok: true, inserted: 1, replied: 0 }), { status: 200 }));
    resolveA(new Response('server error', { status: 500 }));

    const out = await fanoutPromise;

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ backendUrl: A.backendUrl, ok: false, status: 500 });
    expect(out[1]).toMatchObject({ backendUrl: B.backendUrl, ok: true });

    const pairings = ((globalThis as any).chrome.storage.local._s.pairings ?? []) as Array<{
      backendUrl: string;
      lastDmSyncAt?: string;
    }>;
    expect(pairings.find((p) => p.backendUrl === A.backendUrl)?.lastDmSyncAt).toBeUndefined();
    expect(pairings.find((p) => p.backendUrl === B.backendUrl)?.lastDmSyncAt).toBeTruthy();
  });

  it('does not bump lastDmSyncAt for an empty status heartbeat, even on 200', async () => {
    // The heartbeat (empty items/comments) must not advance the inbox cursor:
    // otherwise a tick where the poll failed but the heartbeat succeeded would
    // move the watermark past messages that arrived during the outage.
    seed([A]);
    const { api } = await import('../../src/lib/api.js');
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, inserted: 0, replied: 0 }), { status: 200 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await api.dmSync('reddit', [], [], {
      chat: 'ok',
      legacy: 'ok',
      captured_at: 'now',
    });
    expect(out[0].ok).toBe(true);

    const pairings = ((globalThis as any).chrome.storage.local._s.pairings ?? []) as Array<{
      backendUrl: string;
      lastDmSyncAt?: string;
    }>;
    expect(pairings[0].lastDmSyncAt).toBeUndefined();
  });

  it('does not send message bodies to a pairing that has not consented (#186)', async () => {
    seed([
      { backendUrl: 'https://noconsent.example', token: 'tn' },
      { backendUrl: 'https://ok.example', token: 'to', consentAckAt: '2026-01-01T00:00:00Z' },
    ]);
    const { api } = await import('../../src/lib/api.js');
    const bodies: Record<string, { items: unknown[]; comments: unknown[] }> = {};
    const fetchMock = vi.fn((url: string, init: { body: string }) => {
      bodies[String(url)] = JSON.parse(init.body);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, inserted: 0, replied: 0 }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.dmSync('reddit', [{ from: 'x' }], [{ c: 1 }]);

    // Unconsented pairing: no message bodies (status heartbeat only).
    expect(bodies['https://noconsent.example/api/extension/dm-sync'].items).toEqual([]);
    expect(bodies['https://noconsent.example/api/extension/dm-sync'].comments).toEqual([]);
    // Consented pairing: real items + comments delivered.
    expect(bodies['https://ok.example/api/extension/dm-sync'].items).toEqual([{ from: 'x' }]);
    expect(bodies['https://ok.example/api/extension/dm-sync'].comments).toEqual([{ c: 1 }]);
  });
});
