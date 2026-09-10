// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `ensurePanelFont` registers Inter for the in-page panel through the FontFace
 * API, because an `@font-face` inside a shadow root is ignored.
 *
 * What is under test is the one line that decides *which URL* the face is
 * built from, and it is not a detail: the panel content scripts are built as a
 * single-file IIFE (`build.lib`), and Vite inlines a lib build's assets, so
 * the import resolves to `data:font/woff2;base64,...` rather than to a path.
 * The old scheme test required `://`, so a `data:` URL fell through to
 * `chrome.runtime.getURL()` and produced
 * `chrome-extension://<id>/data:font/woff2;base64,...`, a 404. Measured on the
 * real LinkedIn feed on 2026-09-10: the panel logged "panel font unavailable
 * NetworkError" on every mount and rendered in its fallback stack, never Inter.
 */

type FontFaceCall = { family: string; source: string };
const calls: FontFaceCall[] = [];
const globalWithChrome = globalThis as unknown as { chrome?: typeof chrome };

class FakeFontFace {
  family: string;
  constructor(family: string, source: string) {
    this.family = family;
    calls.push({ family, source });
  }
  load(): Promise<FakeFontFace> {
    return Promise.resolve(this);
  }
}

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
  vi.stubGlobal('FontFace', FakeFontFace as unknown as typeof FontFace);
  // jsdom implements no `document.fonts`, and the module needs both the
  // iteration (its "already registered" check) and `add`.
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: () => {},
      [Symbol.iterator]: () => [][Symbol.iterator](),
    },
  });
  globalWithChrome.chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://abc/${p}` },
  } as unknown as typeof chrome;
});

afterEach(() => {
  delete globalWithChrome.chrome;
  vi.unstubAllGlobals();
});

/**
 * Reloads the module with the asset import resolved to `resolved`, which is
 * what Vite substitutes at build time and therefore the only input that
 * decides the branch under test.
 *
 * A static import cannot work here: the value being varied *is* a module-level
 * import of the module under test, so each case needs the module evaluated
 * again against a different mock.
 */
async function loadWithAsset(resolved: string) {
  vi.doMock('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url', () => ({
    default: resolved,
  }));
  return await import('../../src/content/shared/panel-fonts.js');
}

describe('ensurePanelFont URL resolution', () => {
  it('uses an inlined data URL verbatim rather than resolving it against the extension origin', async () => {
    const dataUrl = 'data:font/woff2;base64,d09GMgABAAAA';
    const mod = await loadWithAsset(dataUrl);
    mod.resetPanelFontForTests();
    await mod.ensurePanelFont();
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe(`url(${dataUrl})`);
    expect(calls[0].source).not.toContain('chrome-extension://');
  });

  it('resolves a root-relative path against the extension origin, which is what getURL is for', async () => {
    const mod = await loadWithAsset('/assets/inter-latin-wght-normal-abc123.woff2');
    mod.resetPanelFontForTests();
    await mod.ensurePanelFont();
    expect(calls[0].source).toBe(
      'url(chrome-extension://abc/assets/inter-latin-wght-normal-abc123.woff2)',
    );
  });

  it('uses an absolute chrome-extension URL verbatim, as @crxjs already emits one', async () => {
    const url = 'chrome-extension://abc/assets/inter-latin-wght-normal-abc123.woff2';
    const mod = await loadWithAsset(url);
    mod.resetPanelFontForTests();
    await mod.ensurePanelFont();
    expect(calls[0].source).toBe(`url(${url})`);
  });
});
