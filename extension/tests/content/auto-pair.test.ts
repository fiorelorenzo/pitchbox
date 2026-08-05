// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
      async remove(keys: string[]) {
        for (const k of keys) delete (this._s as any)[k];
      },
    },
  },
  runtime: {
    sendMessage: vi.fn((_msg: unknown, cb?: (ack: unknown) => void) => cb?.({ ok: true })),
  },
};

function setBeacon() {
  document.head.innerHTML = '<meta name="pitchbox-pair">';
}

// Flush the microtask queue enough times for the content script's async IIFE
// (getSettings -> fetch -> json -> sendMessage) to settle.
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.head.innerHTML = '';
  ((globalThis as any).chrome.storage.local as any)._s = {};
  (globalThis as any).chrome.runtime.sendMessage.mockClear();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importModule() {
  return await import('../../src/content/auto-pair.js');
}

describe('isAlreadyPaired', () => {
  it('is true when a pairing exists for the backend', async () => {
    const { isAlreadyPaired } = await importModule();
    expect(
      isAlreadyPaired([{ backendUrl: 'http://example.test', token: 'x' }], 'http://example.test'),
    ).toBe(true);
  });

  it('is false when no pairing matches the backend', async () => {
    const { isAlreadyPaired } = await importModule();
    expect(
      isAlreadyPaired([{ backendUrl: 'http://other.test', token: 'x' }], 'http://example.test'),
    ).toBe(false);
  });

  it('is false when there are no pairings at all', async () => {
    const { isAlreadyPaired } = await importModule();
    expect(isAlreadyPaired([], 'http://example.test')).toBe(false);
  });
});

describe('auto-pair content script', () => {
  it('skips auto-pair when a pairing already exists for this backend', async () => {
    setBeacon();
    const backendUrl = `${location.protocol}//${location.host}`;
    ((globalThis as any).chrome.storage.local as any)._s.pairings = [
      { backendUrl, token: 'x'.repeat(64) },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair-outcome',
        backendUrl,
        outcome: { kind: 'already-paired' },
      }),
    );
  });

  it('does not skip after repeated reloads for the same already-paired backend', async () => {
    setBeacon();
    const backendUrl = `${location.protocol}//${location.host}`;
    ((globalThis as any).chrome.storage.local as any)._s.pairings = [
      { backendUrl, token: 'x'.repeat(64) },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Simulate several dashboard page loads re-injecting the content script.
    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      await importModule();
      await flush();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pairs when no pairing exists yet for this backend', async () => {
    setBeacon();
    const fetchMock = vi.fn(async () =>
      Object.assign(new Response(JSON.stringify({ token: 'y'.repeat(64) }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // #195: this mints a device token as a side effect, so it must be a POST,
    // not a "safe" GET that a cross-site request could ride in on.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/extension/auto-pair'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalled();
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair-outcome',
        backendUrl: `${location.protocol}//${location.host}`,
        outcome: { kind: 'paired' },
      }),
    );
  });

  it('forwards orgName and deviceLabel from the auto-pair response (#200)', async () => {
    setBeacon();
    const fetchMock = vi.fn(async () =>
      Object.assign(
        new Response(
          JSON.stringify({
            token: 'z'.repeat(64),
            orgName: 'Acme Inc',
            deviceLabel: 'Browser extension',
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    const sendMessage = (globalThis as any).chrome.runtime.sendMessage;
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair',
        token: 'z'.repeat(64),
        orgName: 'Acme Inc',
        deviceLabel: 'Browser extension',
      }),
      expect.any(Function),
    );
  });

  it('does not crash when the response omits orgName/deviceLabel', async () => {
    setBeacon();
    const fetchMock = vi.fn(async () =>
      Object.assign(new Response(JSON.stringify({ token: 'w'.repeat(64) }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    const sendMessage = (globalThis as any).chrome.runtime.sendMessage;
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pitchbox:auto-pair', token: 'w'.repeat(64) }),
      expect.any(Function),
    );
  });
});

describe('auto-pair outcome reporting (#257)', () => {
  it('reports no-dashboard when the page has no pitchbox-pair beacon', async () => {
    // beforeEach leaves document.head empty - no setBeacon() call here.
    const backendUrl = `${location.protocol}//${location.host}`;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair-outcome',
        backendUrl,
        outcome: { kind: 'no-dashboard' },
      }),
    );
  });

  it('reports unauthorized when the dashboard responds 401 (not signed in)', async () => {
    setBeacon();
    const backendUrl = `${location.protocol}//${location.host}`;
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair-outcome',
        backendUrl,
        outcome: { kind: 'unauthorized' },
      }),
    );
  });

  it('reports network-error when the fetch itself throws', async () => {
    setBeacon();
    const backendUrl = `${location.protocol}//${location.host}`;
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair-outcome',
        backendUrl,
        outcome: { kind: 'network-error' },
      }),
    );
  });

  it('reports server-error with the status for a non-200, non-401 response', async () => {
    setBeacon();
    const backendUrl = `${location.protocol}//${location.host}`;
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:auto-pair-outcome',
        backendUrl,
        outcome: { kind: 'server-error', httpStatus: 500 },
      }),
    );
  });
});
