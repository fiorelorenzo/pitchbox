import { describe, it, expect, vi, beforeEach } from 'vitest';

// #203: minimal chrome mock covering everything background.ts touches at
// import time (listener registration) plus what handleInstalled/applyAlarms
// exercise: storage.local get/set, alarms clear/create, and runtime.getManifest
// for the upgrade message's `to` version.
(globalThis as any).chrome = {
  storage: {
    local: {
      _s: {} as Record<string, unknown>,
      async get(keys: string | string[]) {
        const k = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const x of k) if (x in (this._s as any)) out[x] = (this._s as any)[x];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(this._s as any, patch);
      },
      async remove() {
        // no-op: unused by the paths under test here.
      },
    },
    onChanged: { addListener: vi.fn() },
  },
  alarms: {
    clear: vi.fn(async () => true),
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    getManifest: () => ({ version: '2.5.0' }) as chrome.runtime.Manifest,
  },
};

beforeEach(() => {
  ((globalThis as any).chrome.storage.local as any)._s = {};
  vi.clearAllMocks();
});

async function importBackground() {
  return await import('../../src/background.js');
}

async function importActivity() {
  return await import('../../src/lib/activity.js');
}

describe('handleInstalled (#203)', () => {
  it('logs a distinct first-run event on a fresh install, not the generic boot message', async () => {
    const { handleInstalled } = await importBackground();
    const { getActivity } = await importActivity();
    await handleInstalled({ reason: 'install' } as chrome.runtime.InstalledDetails);
    const all = await getActivity();
    expect(all[0]).toMatchObject({ source: 'system', message: 'activity.system.installed' });
    expect(all.some((e) => e.message === 'activity.system.boot')).toBe(false);
  });

  it('logs activity.system.upgraded with from (previousVersion) and to (manifest version) on update', async () => {
    const { handleInstalled } = await importBackground();
    const { getActivity } = await importActivity();
    await handleInstalled({
      reason: 'update',
      previousVersion: '1.2.3',
    } as chrome.runtime.InstalledDetails);
    const all = await getActivity();
    expect(all[0]).toMatchObject({
      source: 'system',
      message: 'activity.system.upgraded',
      messageParams: { from: '1.2.3', to: '2.5.0' },
    });
  });

  it('falls back to the generic boot message for chrome_update/shared_module_update', async () => {
    const { handleInstalled } = await importBackground();
    const { getActivity } = await importActivity();
    await handleInstalled({ reason: 'chrome_update' } as chrome.runtime.InstalledDetails);
    const all = await getActivity();
    expect(all[0]).toMatchObject({ source: 'system', message: 'activity.system.boot' });
  });
});

describe('classifyInbox (#178)', () => {
  it('maps a revoked device token (401) to unauthorized', async () => {
    const { classifyInbox } = await importBackground();
    expect(classifyInbox({ ok: false, reason: 'device-revoked' })).toBe('unauthorized');
  });

  it('still maps not-logged-in to unauthorized', async () => {
    const { classifyInbox } = await importBackground();
    expect(classifyInbox({ ok: false, reason: 'not-logged-in' })).toBe('unauthorized');
  });

  it('buckets an unrelated failure reason as error', async () => {
    const { classifyInbox } = await importBackground();
    expect(classifyInbox({ ok: false, reason: 'http 500' })).toBe('error');
  });

  it('maps ok results to ok', async () => {
    const { classifyInbox } = await importBackground();
    expect(classifyInbox({ ok: true, inserted: 1, replied: 0 })).toBe('ok');
  });
});
