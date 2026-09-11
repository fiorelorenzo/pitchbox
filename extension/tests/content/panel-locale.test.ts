// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolvePanelLocale } from '../../src/content/shared/panel-locale.js';
import panelLocaleSource from '../../src/content/shared/panel-locale.ts?raw';

/**
 * LOR-261: the in-page panel resolved its locale from nowhere - `setLocale`
 * was only ever called from the side panel, so the panel-bearing content
 * scripts rendered at DEFAULT_LOCALE for the page's whole lifetime no matter
 * what the operator had set. This covers the resolver in isolation; the
 * actual wiring into the panel (calling `setLocale` with what this returns)
 * is covered against the real content scripts in
 * `linkedin-post-assist-locale.test.ts`.
 */

let sendMessageMock = vi.fn();
let runtimeStub: { sendMessage: typeof sendMessageMock; lastError?: unknown };
const globalWithChrome = globalThis as unknown as { chrome: typeof chrome };

beforeEach(() => {
  sendMessageMock = vi.fn();
  runtimeStub = { sendMessage: sendMessageMock, lastError: undefined };
  globalWithChrome.chrome = { runtime: runtimeStub } as unknown as typeof chrome;
});

/** Mimics the background worker's own callback-style `sendMessage` reply. */
function respondWith(response: unknown): void {
  sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => cb(response));
}

describe('resolvePanelLocale (LOR-261)', () => {
  it('asks the background worker and returns the locale it answers with', async () => {
    respondWith({ ok: true, locale: 'it' });
    expect(await resolvePanelLocale()).toBe('it');
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'pitchbox:resolve-locale' },
      expect.any(Function),
    );
  });

  it('defaults to en when the worker reports it could not resolve one', async () => {
    respondWith({ ok: false });
    expect(await resolvePanelLocale()).toBe('en');
  });

  it('defaults to en when chrome.runtime.lastError is set on the reply', async () => {
    sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => {
      runtimeStub.lastError = { message: 'Extension context invalidated.' };
      cb(undefined);
    });
    expect(await resolvePanelLocale()).toBe('en');
  });

  it('defaults to en without messaging anything when chrome is entirely absent', async () => {
    // @ts-expect-error - simulates a realm with no extension APIs at all.
    delete globalThis.chrome;
    expect(await resolvePanelLocale()).toBe('en');
  });

  it('defaults to en when chrome.runtime.sendMessage is not a function', async () => {
    globalWithChrome.chrome = { runtime: {} } as unknown as typeof chrome;
    expect(await resolvePanelLocale()).toBe('en');
  });

  it('defaults to en rather than throwing when sendMessage itself throws (a dead extension context)', async () => {
    sendMessageMock.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    await expect(resolvePanelLocale()).resolves.toBe('en');
  });

  it('never fetches, never touches cookies or storage - the whole point is not reading it here', () => {
    // Strip the module doc comment first: it explains chrome.storage by name
    // (why this module deliberately does not read it), which would otherwise
    // read as a false positive against the same regex the real code check
    // needs.
    const code = panelLocaleSource.replace(/\/\*[\s\S]*?\*\//, '');
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
    expect(code).not.toMatch(
      /document\.cookie|localStorage|sessionStorage|chrome\.cookies|chrome\.storage/,
    );
  });
});
