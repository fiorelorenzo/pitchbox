import { describe, it, expect, beforeEach } from 'vitest';

// Minimal chrome.storage.local mock so storage.ts's getSettings()/upsertPairing()/
// patchPairing() resolve, matching the pick-pairing.test.ts pattern.
/* eslint-disable @typescript-eslint/no-explicit-any */
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

beforeEach(() => {
  (globalThis as any).chrome.storage.local._s = {};
});

describe('pairingHealth / overallHealth (#178 honest status)', () => {
  it('is warn when a pairing has never synced', async () => {
    const { pairingHealth } = await import('../../src/lib/storage.js');
    expect(pairingHealth({ backendUrl: 'https://a.example', token: 't' })).toBe('warn');
  });

  it('is ok when both channels report ok and the snapshot is fresh', async () => {
    const { pairingHealth } = await import('../../src/lib/storage.js');
    const now = Date.now();
    expect(
      pairingHealth(
        {
          backendUrl: 'https://a.example',
          token: 't',
          syncStatus: { chat: 'ok', legacy: 'ok', capturedAt: new Date(now).toISOString() },
        },
        now,
      ),
    ).toBe('ok');
  });

  it('still reports ok when the snapshot is fresh but not brand new', async () => {
    const { pairingHealth } = await import('../../src/lib/storage.js');
    const now = Date.now();
    const capturedAt = new Date(now - 10 * 60 * 1000).toISOString(); // 10m old
    expect(
      pairingHealth(
        {
          backendUrl: 'https://a.example',
          token: 't',
          syncStatus: { chat: 'ok', legacy: 'ok', capturedAt },
        },
        now,
      ),
    ).toBe('ok');
  });

  it('is the worst of chat/legacy - error beats warn beats ok', async () => {
    const { pairingHealth } = await import('../../src/lib/storage.js');
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    expect(
      pairingHealth(
        {
          backendUrl: 'https://a.example',
          token: 't',
          syncStatus: { chat: 'unauthorized', legacy: 'ok', capturedAt: fresh },
        },
        now,
      ),
    ).toBe('warn');
    expect(
      pairingHealth(
        {
          backendUrl: 'https://a.example',
          token: 't',
          syncStatus: { chat: 'error', legacy: 'unauthorized', capturedAt: fresh },
        },
        now,
      ),
    ).toBe('error');
  });

  it('treats an unknown channel as warn, not ok', async () => {
    const { pairingHealth } = await import('../../src/lib/storage.js');
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    expect(
      pairingHealth(
        {
          backendUrl: 'https://a.example',
          token: 't',
          syncStatus: { chat: 'unknown', legacy: 'ok', capturedAt: fresh },
        },
        now,
      ),
    ).toBe('warn');
  });

  it('downgrades a stale "ok" snapshot to warn so a dead worker cannot show green forever', async () => {
    const { pairingHealth } = await import('../../src/lib/storage.js');
    const now = Date.now();
    const staleCapturedAt = new Date(now - 60 * 60 * 1000).toISOString(); // 1h old
    expect(
      pairingHealth(
        {
          backendUrl: 'https://a.example',
          token: 't',
          syncStatus: { chat: 'ok', legacy: 'ok', capturedAt: staleCapturedAt },
        },
        now,
      ),
    ).toBe('warn');
  });

  it('overallHealth is the worst across every pairing', async () => {
    const { overallHealth } = await import('../../src/lib/storage.js');
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const ok = {
      backendUrl: 'https://a.example',
      token: 't',
      syncStatus: { chat: 'ok' as const, legacy: 'ok' as const, capturedAt: fresh },
    };
    const errored = {
      backendUrl: 'https://b.example',
      token: 't',
      syncStatus: { chat: 'error' as const, legacy: 'ok' as const, capturedAt: fresh },
    };
    expect(overallHealth([ok], now)).toBe('ok');
    expect(overallHealth([ok, errored], now)).toBe('error');
    expect(overallHealth([], now)).toBe('ok');
  });
});

describe('Pairing shape (#200 identity, #186 consent)', () => {
  it('round-trips orgName, deviceLabel, and consentAckAt through upsertPairing/patchPairing', async () => {
    const { upsertPairing, patchPairing, getSettings } = await import('../../src/lib/storage.js');
    await upsertPairing({
      backendUrl: 'https://a.example',
      token: 't',
      orgName: 'Acme Inc',
      deviceLabel: 'Browser extension (Chrome)',
    });
    let { pairings } = await getSettings();
    expect(pairings[0]).toMatchObject({
      backendUrl: 'https://a.example',
      orgName: 'Acme Inc',
      deviceLabel: 'Browser extension (Chrome)',
    });
    expect(pairings[0].consentAckAt).toBeUndefined();

    await patchPairing('https://a.example', { consentAckAt: '2026-07-15T00:00:00.000Z' });
    ({ pairings } = await getSettings());
    expect(pairings[0].consentAckAt).toBe('2026-07-15T00:00:00.000Z');
  });
});
