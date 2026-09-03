/**
 * Registers Inter for the in-page panel.
 *
 * An `@font-face` rule declared inside a shadow root is ignored: font faces are
 * resolved against the document, not the shadow tree, so the panel's own
 * stylesheet cannot carry the face it needs. The two ways out are injecting an
 * `@font-face` rule into the host document's `<head>`, or adding the face
 * through the FontFace API. This module does the second, because it puts a font
 * in linkedin.com's font set without putting a single style rule in
 * linkedin.com's stylesheet, and because it fails loudly (a rejected promise)
 * instead of silently doing nothing.
 *
 * Inter reaches the extension from npm rather than the tree
 * (`@fontsource-variable/inter`, see the repo's AGENTS.md), so the `.woff2` is
 * resolved through Vite's asset pipeline and served from the extension's own
 * origin. That URL is only readable from a content script when the file is
 * listed in `web_accessible_resources`; `manifest.config.ts` lists it.
 */

// Vite rewrites this to the emitted asset path at build time. The `?url`
// suffix asks for the URL rather than the file's contents.
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

const FAMILY = 'Inter Variable';

/** Resolves once the face is registered, or rejects with why it could not be. */
let pending: Promise<void> | null = null;

/**
 * Adds Inter to the host document's font set, once per page. Safe to call from
 * every panel mount: repeat calls return the first call's promise.
 *
 * Never throws at the call site. A failure here degrades the panel to its
 * fallback stack (see `--panel-font-stack` in `panel.css`) and is worth a log
 * line, not an abort: a panel in Helvetica is a cosmetic defect, a panel that
 * refused to mount is a broken feature.
 */
export function ensurePanelFont(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) {
      throw new Error('FontFace API unavailable');
    }
    // Already registered by an earlier content script on this page, or by the
    // host itself. Checking is cheaper than adding a duplicate face.
    //
    // The quote-stripping is not defensive dressing: `FontFace.family` returns
    // the *serialized* family name, so a name containing a space comes back
    // quoted (`"Inter Variable"`, not `Inter Variable`). Comparing against the
    // bare name therefore never matches, and this check silently did nothing
    // until a browser run printed the real value.
    const unquote = (name: string) => name.replace(/^["']|["']$/g, '');
    for (const face of document.fonts) {
      if (unquote(face.family) === FAMILY) return;
    }
    // Under @crxjs the import above is already an absolute
    // `chrome-extension://` URL. The fallbacks are for a path that came back
    // root-relative: inside an extension it is resolved against the
    // extension's own origin, and outside one (the smoke harness, a plain Vite
    // build) against the page's, which is also what makes this path checkable
    // in a browser at all.
    //
    // `typeof chrome`, not `chrome?.`: optional chaining does not protect
    // against an *undeclared* identifier, so `chrome?.runtime` throws a
    // ReferenceError outside an extension rather than yielding undefined. That
    // is not hypothetical - it is what made this branch unverifiable until it
    // was measured.
    const extensionUrl =
      typeof chrome !== 'undefined'
        ? chrome.runtime?.getURL?.(interLatin.replace(/^\/+/, ''))
        : undefined;
    const url = /^[a-z-]+:\/\//i.test(interLatin)
      ? interLatin
      : (extensionUrl ?? new URL(interLatin, location.href).href);
    const face = new FontFace(FAMILY, `url(${url})`, {
      weight: '100 900',
      style: 'normal',
      display: 'swap',
    });
    await face.load();
    document.fonts.add(face);
  })();
  return pending;
}

/** Test seam: forget the memoised registration. */
export function resetPanelFontForTests(): void {
  pending = null;
}
