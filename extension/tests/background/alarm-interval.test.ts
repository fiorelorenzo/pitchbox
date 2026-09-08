import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionSettings } from '../../src/lib/settings.js';

// #402: the poller interval looked configurable but applyAlarms() ran on
// every chrome.storage.onChanged for `extensionSettings`, not just a
// syncIntervalMin write. Since applyAlarms() unconditionally clears and
// recreates the alarm, an unrelated write (theme, a poller switch) reset
// scheduledTime to a fresh full period and silently pushed the next sync
// back, even though the interval value itself never changed.
//
// The fix reads chrome.alarms.get() live rather than keeping a "prior
// settings" snapshot in a module-level variable, because a service worker is
// evicted between events and anything held only in memory is gone on the
// next wake - a guard built on it would stop guarding after the first
// eviction. These tests exercise that: whether the alarm is recreated, and
// with what period, verified through chrome.alarms itself.

const ALARM = 'pitchbox:dm-sync';

// Stands in for the platform's own alarm bookkeeping - persists across a
// `vi.resetModules()` re-import the same way a real alarm survives a service
// worker restart, since the test never resets this except when explicitly
// simulating a fresh install.
let alarmStore: Record<string, { periodInMinutes: number }> = {};

function makeChrome() {
  return {
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
      clear: vi.fn(async (name: string) => {
        const existed = name in alarmStore;
        delete alarmStore[name];
        return existed;
      }),
      create: vi.fn((name: string, info: { periodInMinutes: number }) => {
        alarmStore[name] = { periodInMinutes: info.periodInMinutes };
      }),
      get: vi.fn(async (name: string) =>
        name in alarmStore ? { name, ...alarmStore[name] } : undefined,
      ),
      onAlarm: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () => []),
      registerContentScripts: vi.fn(async () => undefined),
      unregisterContentScripts: vi.fn(async () => undefined),
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getManifest: () => ({ version: '2.5.0' }) as chrome.runtime.Manifest,
    },
  };
}

/** Flush pending promise microtasks without depending on real/fake timers. */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const BASE: ExtensionSettings = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en',
  syncIntervalMin: 10,
  legacyPollerEnabled: true,
  chatPollerEnabled: true,
};

/** Fresh module instance with a clean platform state - a cold install. */
async function importFreshBackground() {
  vi.resetModules();
  alarmStore = {};
  (globalThis as any).chrome = makeChrome();
  return await import('../../src/background.js');
}

/**
 * Re-import background.ts as a brand new module instance while keeping
 * whatever is currently in `chrome.storage.local` and `alarmStore` - i.e.
 * simulating the service worker being evicted and woken back up. Nothing the
 * old module instance observed carries over; only the platform state does.
 */
async function reimportAfterEviction() {
  const preservedStorage = (globalThis as any).chrome.storage.local._s;
  vi.resetModules();
  (globalThis as any).chrome = makeChrome();
  (globalThis as any).chrome.storage.local._s = preservedStorage;
  return await import('../../src/background.js');
}

function fireSettingsChange(oldValue: ExtensionSettings, newValue: ExtensionSettings) {
  (globalThis as any).chrome.storage.local._s.extensionSettings = newValue;
  const onChanged = ((globalThis as any).chrome.storage.onChanged.addListener as any).mock
    .calls[0][0];
  onChanged({ extensionSettings: { oldValue, newValue } }, 'local');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('alarm reapplication on settings writes (#402)', () => {
  it('does not recreate the alarm when an unrelated settings field changes', async () => {
    await importFreshBackground();
    (globalThis as any).chrome.storage.local._s.extensionSettings = BASE;
    alarmStore[ALARM] = { periodInMinutes: BASE.syncIntervalMin };

    fireSettingsChange(BASE, { ...BASE, theme: 'dark' });
    await flush();

    expect((globalThis as any).chrome.alarms.create).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.alarms.clear).not.toHaveBeenCalled();
    expect(await (globalThis as any).chrome.alarms.get(ALARM)).toEqual({
      name: ALARM,
      periodInMinutes: 10,
    });
  });

  it('recreates the alarm with the new period when syncIntervalMin changes', async () => {
    await importFreshBackground();
    (globalThis as any).chrome.storage.local._s.extensionSettings = BASE;
    alarmStore[ALARM] = { periodInMinutes: BASE.syncIntervalMin };

    fireSettingsChange(BASE, { ...BASE, syncIntervalMin: 5 });
    await flush();

    expect((globalThis as any).chrome.alarms.create).toHaveBeenCalledTimes(1);
    expect(await (globalThis as any).chrome.alarms.get(ALARM)).toEqual({
      name: ALARM,
      periodInMinutes: 5,
    });
  });

  it('reconciles against the live alarm after a service worker eviction, with no settings history in memory', async () => {
    // A warm worker picks up an interval change to 5 the normal way.
    await importFreshBackground();
    (globalThis as any).chrome.storage.local._s.extensionSettings = BASE;
    alarmStore[ALARM] = { periodInMinutes: BASE.syncIntervalMin };
    fireSettingsChange(BASE, { ...BASE, syncIntervalMin: 5 });
    await flush();
    const settled: ExtensionSettings = { ...BASE, syncIntervalMin: 5 };
    expect(await (globalThis as any).chrome.alarms.get(ALARM)).toEqual({
      name: ALARM,
      periodInMinutes: 5,
    });

    // The worker is evicted and a brand new module instance loads. It has
    // never seen `settled` - only chrome.storage and chrome.alarms (the real
    // platform state) survive the restart. An unrelated write must still be
    // recognised as a no-op for the alarm.
    await reimportAfterEviction();
    fireSettingsChange(settled, { ...settled, locale: 'it' });
    await flush();

    expect((globalThis as any).chrome.alarms.create).not.toHaveBeenCalled();
    expect(await (globalThis as any).chrome.alarms.get(ALARM)).toEqual({
      name: ALARM,
      periodInMinutes: 5,
    });
  });
});
