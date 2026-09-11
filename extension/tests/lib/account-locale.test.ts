import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyAccountLocale } from '../../src/lib/account-locale.js';
import { getSettings, setSettings } from '../../src/lib/settings.js';
import { getLocale } from '../../src/lib/i18n/index.js';

type ChromeStorageLocalStub = {
  _s: Record<string, unknown>;
  get(keys: string[] | string): Promise<Record<string, unknown>>;
  set(patch: Record<string, unknown>): Promise<void>;
};

// Same minimal chrome.storage.local stub as settings.test.ts - this module
// is a thin layer on top of getSettings/setSettings, so it needs the same
// fake, not a second one. `chrome` genuinely does not exist in this test
// runtime, so the assignment is an unchecked boundary cast, named once here
// rather than repeated inline at each access below.
const chromeStub = {
  storage: {
    local: {
      _s: {},
      async get(keys) {
        const k = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const x of k) if (x in this._s) out[x] = this._s[x];
        return out;
      },
      async set(patch) {
        Object.assign(this._s, patch);
      },
    } satisfies ChromeStorageLocalStub,
  },
};
(globalThis as unknown as { chrome: typeof chromeStub }).chrome = chromeStub;

beforeEach(() => {
  chromeStub.storage.local._s = {};
});

describe('applyAccountLocale (LOR-262)', () => {
  it('is a no-op for null - the device has no account preference to apply', async () => {
    await applyAccountLocale(null);
    expect((await getSettings()).locale).toBe('en');
  });

  it('is a no-op for a value outside the supported set, never throws', async () => {
    await expect(applyAccountLocale('fr')).resolves.toBeUndefined();
    expect((await getSettings()).locale).toBe('en');
  });

  it("writes the account's locale through to local storage and the live i18n store", async () => {
    await applyAccountLocale('it');
    expect((await getSettings()).locale).toBe('it');
    expect(getLocale()).toBe('it');
  });

  it('never writes to storage when the account value already matches (no redundant chrome.storage.local.set)', async () => {
    await setSettings({ locale: 'it' });
    const setSpy = vi.spyOn(chromeStub.storage.local, 'set');
    await applyAccountLocale('it');
    expect(setSpy).not.toHaveBeenCalled();
  });
});
