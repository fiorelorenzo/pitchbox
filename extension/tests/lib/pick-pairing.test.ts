import { describe, it, expect, beforeEach } from 'vitest';

// Minimal chrome.storage.local mock so api.ts's getSettings() resolves.
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

function seed(pairings: Array<{ backendUrl: string; token: string }>) {
  (globalThis as any).chrome.storage.local._s = { pairings };
}

beforeEach(() => {
  (globalThis as any).chrome.storage.local._s = {};
});

const A = { backendUrl: 'https://a.example', token: 'ta' };
const B = { backendUrl: 'https://b.example', token: 'tb' };

describe('pickPairing', () => {
  it('returns null when nothing is paired', async () => {
    const { pickPairing } = await import('../../src/lib/api.js');
    expect(await pickPairing()).toBeNull();
    expect(await pickPairing('https://a.example')).toBeNull();
  });

  it('routes to the exact requested backend (trailing slash tolerant)', async () => {
    seed([A, B]);
    const { pickPairing } = await import('../../src/lib/api.js');
    expect((await pickPairing('https://b.example'))?.backendUrl).toBe('https://b.example');
    expect((await pickPairing('https://b.example/'))?.backendUrl).toBe('https://b.example');
  });

  it('falls back to the first pairing when omitted or unmatched (never fails a lone install)', async () => {
    seed([A, B]);
    const { pickPairing } = await import('../../src/lib/api.js');
    expect((await pickPairing())?.backendUrl).toBe('https://a.example');
    expect((await pickPairing('https://unknown.example'))?.backendUrl).toBe('https://a.example');
  });
});
