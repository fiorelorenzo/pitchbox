// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * LOR-261, end to end: the panel-bearing content script asks the background
 * worker for the operator's locale on load and applies it before a human
 * ever clicks anything - not just "the panel renders `$t()` correctly once
 * told" (`panel-locale-render.test.ts` covers that half), and not just "the
 * resolver returns the right value" (`panel-locale.test.ts` covers that
 * half). This is the wiring between the two that was actually missing: the
 * module load simulated here is exactly `linkedin-post-assist.ts`'s own
 * `if (claimDocument(...)) { init(); void resolvePanelLocale().then(setLocale); }`,
 * against a `chrome.runtime.sendMessage` stub that answers the way the real
 * background worker's `pitchbox:resolve-locale` handler does.
 *
 * `chrome` has to be stubbed with the Italian answer *before* this module is
 * imported, since that `void resolvePanelLocale().then(setLocale)` call runs
 * once at import time (guarded by `claimDocument`, matching every other
 * content script here) - hence this lives in its own file rather than a
 * `describe` block appended to `linkedin-post-assist.test.ts`, whose module
 * import already happened (with no `chrome` at all) before any test in that
 * file gets to run.
 */

const linkedinAssist = vi.fn();
const suggest = vi.fn();
const acceptSuggestion = vi.fn();
const pickPairing = vi.fn(async () => ({ backendUrl: 'https://app.pitchbox.app' }));

vi.mock('../../src/lib/api.js', () => ({
  api: {
    linkedinAssist: () => linkedinAssist(),
    suggest: (body: unknown, onEvent: unknown) => suggest(body, onEvent),
    acceptSuggestion: (body: unknown) => acceptSuggestion(body),
  },
  pickPairing: () => pickPairing(),
}));

vi.mock('../../src/lib/log-from-content.js', () => ({
  logFromContent: () => {
    // Not asserted on in this file.
  },
}));

const sendMessageMock = vi.fn((_msg: unknown, cb: (res: { ok: true; locale: 'it' }) => void) => {
  cb({ ok: true, locale: 'it' });
});
(globalThis as unknown as { chrome: typeof chrome }).chrome = {
  runtime: { id: 'pitchbox-test-extension', sendMessage: sendMessageMock, lastError: undefined },
} as unknown as typeof chrome;

// Dynamic, not static: this module must load after the `chrome` stub above
// is installed - a static import would be hoisted ahead of it, and the
// module-load-time locale resolution this test exists to cover would see no
// `chrome.runtime.sendMessage` at all, matching
// `linkedin-comment-assist.test.ts`'s own established reason for the same
// dynamic-import posture.
const { wirePostAssist } = await import('../../src/content/linkedin-post-assist.js');

function renderModal(): { modal: HTMLElement; editor: HTMLElement } {
  document.body.innerHTML =
    '<div role="dialog"><div contenteditable="true" role="textbox"></div></div>';
  const modal = document.querySelector<HTMLElement>('[role="dialog"]');
  const editor = modal?.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
  if (!modal || !editor) throw new Error('synthetic modal build failed');
  return { modal, editor };
}

function panelText(): string {
  const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
  if (!host?.shadowRoot) throw new Error('no panel mounted');
  return (host.shadowRoot.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Lets the module-load locale resolution and the panel's mount settle.
 * Mirrors `linkedin-post-assist.test.ts`'s own `settle()` verbatim (a
 * zero-delay `setTimeout`, not a guessed duration, since this repo's
 * content-script test files use the same helper for every real Svelte
 * mount/effect flush): a `Promise.resolve()` chain alone drains the
 * microtask queue, not the macrotask tick Svelte's own scheduling and the
 * `chrome.runtime.sendMessage` callback round trip both land on.
 */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(async () => {
  document.body.innerHTML = '';
  linkedinAssist.mockClear();
  suggest.mockClear();
  acceptSuggestion.mockClear();
  pickPairing.mockClear();
  linkedinAssist.mockResolvedValue({
    ok: true,
    data: { assist: { enabled: true, killSwitch: false } },
  });
  // The module-load resolution already ran once at import time, above -
  // this only lets it (and any leftover microtasks from a prior test) drain
  // before the assertions below depend on `setLocale` having been called.
  await settle();
});

// This file has only one test, so there is no later `beforeEach` to trigger
// panel-host's own anchor-removal cleanup before jsdom tears down - without
// this, a mounted panel's leftover `MutationObserver` callback can fire once
// `window`/`document` are already gone. Mirrors
// `linkedin-comment-assist.test.ts`'s own `afterEach` for the same reason.
afterEach(async () => {
  document.body.innerHTML = '';
  await settle();
});

describe('the post-assist panel resolves Italian through the worker, before any click (LOR-261)', () => {
  it('mounts already in Italian - the operator never sees a flash of English first', async () => {
    const { editor, modal } = renderModal();
    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const text = panelText();
    expect(text).toContain('Suggerisci un post');
    expect(text).toContain('Ottieni un post suggerito da Pitchbox per la tua rete.');
    expect(text).not.toContain('Suggest a post');
  });
});
