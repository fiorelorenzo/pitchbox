import { describe, it, expect, beforeEach } from 'vitest';

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
    },
  },
};

beforeEach(() => {
  ((globalThis as any).chrome.storage.local as any)._s = {};
});

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    const { getSettings, DEFAULTS } = await import('../../src/lib/settings.js');
    const s = await getSettings();
    expect(s).toEqual(DEFAULTS);
  });

  it('merges partial patch with defaults', async () => {
    const { setSettings, getSettings, DEFAULTS } = await import('../../src/lib/settings.js');
    const next = await setSettings({ theme: 'dark', syncIntervalMin: 5 });
    expect(next.theme).toBe('dark');
    expect(next.syncIntervalMin).toBe(5);
    expect(next.density).toBe(DEFAULTS.density);
    expect((await getSettings()).theme).toBe('dark');
  });

  it('rejects invalid sync interval and keeps prior value', async () => {
    const { setSettings, getSettings } = await import('../../src/lib/settings.js');
    await setSettings({ syncIntervalMin: 10 });
    // @ts-expect-error invalid on purpose
    await setSettings({ syncIntervalMin: 7 });
    expect((await getSettings()).syncIntervalMin).toBe(10);
  });

  it('persists locale and density as-is', async () => {
    const { setSettings, getSettings } = await import('../../src/lib/settings.js');
    await setSettings({ locale: 'it', density: 'compact' });
    const s = await getSettings();
    expect(s.locale).toBe('it');
    expect(s.density).toBe('compact');
  });
});
