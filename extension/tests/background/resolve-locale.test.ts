import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * LOR-261: the in-page LinkedIn panel asks the background worker for the
 * operator's locale rather than reading `chrome.storage` itself (see
 * `content/shared/panel-locale.ts`'s own doc comment for why). This covers
 * the worker side of that round trip: `pitchbox:resolve-locale` resolves
 * through the same `resolveInitialLocale()` the side panel's `main.ts`
 * already trusted, and answers `{ ok: true, locale }` for every input,
 * never a throw the caller would have to guard against.
 */

type MessageListener = (
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

let messageListener: MessageListener | undefined;
let storedSettings: Record<string, unknown> = {};
let uiLanguage = 'en-US';

const chromeMock = {
  storage: {
    local: {
      async get(keys: string | string[]) {
        const requested = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of requested) if (key in storedSettings) out[key] = storedSettings[key];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(storedSettings, patch);
      },
      async remove() {
        // no-op: unused by the path under test here.
      },
    },
    onChanged: { addListener: vi.fn() },
  },
  alarms: {
    clear: vi.fn(async () => true),
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  permissions: {
    contains: vi.fn(async () => false),
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
    onMessage: {
      addListener: vi.fn((listener: MessageListener) => {
        messageListener = listener;
      }),
    },
    getManifest: () => ({ version: '2.5.0' }) as chrome.runtime.Manifest,
  },
  i18n: {
    getUILanguage: () => uiLanguage,
  },
};
(globalThis as unknown as { chrome: typeof chrome }).chrome =
  chromeMock as unknown as typeof chrome;

// Dynamic, not static: this exercises background.ts's own module-load-time
// listener registration against the chrome mock above, matching every
// sibling file in this directory (lifecycle.test.ts,
// linkedin-registration-matches.test.ts) - a static import would run before
// the mock is installed.
await import('../../src/background.js');

beforeEach(() => {
  storedSettings = {};
  uiLanguage = 'en-US';
});

// `Promise.withResolvers` needs an ES2024 lib; extension/tsconfig.json
// targets ES2022, so the executor form is what this project's own
// `check` gate actually accepts here.
function sendMessage(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const returnedTrue = messageListener?.(msg, {} as chrome.runtime.MessageSender, resolve);
    if (!returnedTrue) resolve(undefined);
  });
}

describe('pitchbox:resolve-locale (LOR-261)', () => {
  it('returns the stored preference when the operator set one', async () => {
    storedSettings.extensionSettings = { locale: 'it' };
    await expect(sendMessage({ type: 'pitchbox:resolve-locale' })).resolves.toEqual({
      ok: true,
      locale: 'it',
    });
  });

  it("falls back to the browser's own UI language when no preference is stored", async () => {
    uiLanguage = 'it-IT';
    await expect(sendMessage({ type: 'pitchbox:resolve-locale' })).resolves.toEqual({
      ok: true,
      locale: 'it',
    });
  });

  it('defaults to en when neither a stored preference nor a recognised UI language exists', async () => {
    uiLanguage = 'fr-FR';
    await expect(sendMessage({ type: 'pitchbox:resolve-locale' })).resolves.toEqual({
      ok: true,
      locale: 'en',
    });
  });

  it('the stored preference wins over the UI language when both are present', async () => {
    storedSettings.extensionSettings = { locale: 'en' };
    uiLanguage = 'it-IT';
    await expect(sendMessage({ type: 'pitchbox:resolve-locale' })).resolves.toEqual({
      ok: true,
      locale: 'en',
    });
  });
});
