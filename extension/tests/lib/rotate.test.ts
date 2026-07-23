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

function seed(pairings: Array<Record<string, unknown>>) {
  (globalThis as any).chrome.storage.local._s = { pairings };
}

beforeEach(() => {
  (globalThis as any).chrome.storage.local._s = {};
  vi.restoreAllMocks();
});

describe('shouldRotate (#185)', () => {
  it('is true when the pairing has never been rotated (tokenExpiresAt unset)', async () => {
    const { shouldRotate } = await import('../../src/lib/api.js');
    expect(shouldRotate({})).toBe(true);
  });

  it('is true when the stored expiry is unparsable', async () => {
    const { shouldRotate } = await import('../../src/lib/api.js');
    expect(shouldRotate({ tokenExpiresAt: 'not-a-date' })).toBe(true);
  });

  it('is true when within the rotation buffer of expiry', async () => {
    const { shouldRotate } = await import('../../src/lib/api.js');
    const now = Date.parse('2026-06-01T00:00:00Z');
    const expiresIn10Days = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldRotate({ tokenExpiresAt: expiresIn10Days }, now)).toBe(true);
  });

  it('is false when comfortably far from expiry', async () => {
    const { shouldRotate } = await import('../../src/lib/api.js');
    const now = Date.parse('2026-06-01T00:00:00Z');
    const expiresIn80Days = new Date(now + 80 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldRotate({ tokenExpiresAt: expiresIn80Days }, now)).toBe(false);
  });
});

describe('api.rotate', () => {
  it('persists the new token and expiry on success', async () => {
    seed([{ backendUrl: 'https://a.example', token: 'old-token' }]);
    const { api } = await import('../../src/lib/api.js');

    const fetchMock = vi.fn(async () =>
      Object.assign(
        new Response(
          JSON.stringify({ token: 'new-token', expiresAt: '2026-09-01T00:00:00.000Z' }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.rotate('https://a.example');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://a.example/api/extension/rotate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer old-token' }),
      }),
    );

    const pairings = (globalThis as any).chrome.storage.local._s.pairings as Array<{
      token: string;
      tokenExpiresAt?: string;
    }>;
    expect(pairings[0].token).toBe('new-token');
    expect(pairings[0].tokenExpiresAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('returns not-configured when there is no pairing yet', async () => {
    seed([]);
    const { api } = await import('../../src/lib/api.js');
    const res = await api.rotate();
    expect(res).toEqual({ ok: false, status: 0, error: 'not configured' });
  });
});

describe('api.handshake opportunistic rotation (#185)', () => {
  it('rotates when the pairing has never been rotated yet', async () => {
    seed([{ backendUrl: 'https://a.example', token: 'old-token' }]);
    const { api } = await import('../../src/lib/api.js');

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/extension/handshake')) {
        return new Response(JSON.stringify({ ok: true, version: '1.2.3' }), { status: 200 });
      }
      if (String(url).endsWith('/api/extension/rotate')) {
        return new Response(
          JSON.stringify({ token: 'rotated-token', expiresAt: '2026-09-01T00:00:00.000Z' }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.handshake('https://a.example');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const pairings = (globalThis as any).chrome.storage.local._s.pairings as Array<{
      token: string;
    }>;
    expect(pairings[0].token).toBe('rotated-token');
  });

  it('does not rotate when the pairing is comfortably far from expiry', async () => {
    seed([
      {
        backendUrl: 'https://a.example',
        token: 'old-token',
        tokenExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    const { api } = await import('../../src/lib/api.js');

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, version: '1.2.3' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.handshake('https://a.example');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const pairings = (globalThis as any).chrome.storage.local._s.pairings as Array<{
      token: string;
    }>;
    expect(pairings[0].token).toBe('old-token');
  });

  it('does not rotate when the handshake itself failed', async () => {
    seed([{ backendUrl: 'https://a.example', token: 'old-token' }]);
    const { api } = await import('../../src/lib/api.js');

    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.handshake('https://a.example');
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
