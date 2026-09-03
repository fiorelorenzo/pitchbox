import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `docs/design/DECISIONS.md` D2: the extension keeps a verbatim copy of the
 * dashboard's token values so the two palettes cannot disagree. The recorded
 * failure mode is changing one without the other, which nothing caught until
 * this test existed.
 *
 * The extension side used to be a second copy inside
 * `src/sidepanel/app.css`; it is now `src/lib/tokens.css`, shared with the
 * in-page panel, so there is one copy in the extension rather than one per
 * surface. This test compares that file's declarations against
 * `web/src/app.css`.
 *
 * Two documented, intentional differences are allowed and asserted rather than
 * ignored: the extension omits tokens it has no use for, and adds two of its
 * own. Anything else is drift.
 */

// Repo-relative, derived from this file's own URL: never a machine path.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
/** Tokens the dashboard declares that the extension deliberately does not. */
const EXTENSION_OMITS: Record<string, true> = {
  '--overlay': true,
  '--chart-1': true,
  '--chart-2': true,
  '--chart-3': true,
  '--chart-4': true,
  '--chart-5': true,
};

/** Tokens the extension adds for its own surfaces. */
const EXTENSION_ADDS: Record<string, true> = { '--row-py': true, '--row-px': true };

/**
 * Every `--token: value` declaration inside the first block whose selector
 * list contains `selector`, in source order.
 */
function declarations(css: string, selector: string): Map<string, string> {
  // Comments can sit between a `;`/`}` and the next selector, and both files
  // have plenty; strip them before anything else so a prelude comment cannot
  // end up inside a selector list.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, prelude, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // `[^{}]+` reaches back to the previous brace, so the capture can still
    // carry `@import`/`@custom-variant` statements that ended in `;`. The
    // selector list is whatever follows the last statement terminator.
    const selectors = prelude.slice(prelude.lastIndexOf(';') + 1);
    const names = selectors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.includes(selector)) continue;
    const out = new Map<string, string>();
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(name, value.trim().replace(/\s+/g, ' '));
    }
    if (out.size > 0) return out;
  }
  throw new Error(`no block with selector ${selector} carrying custom properties`);
}

const webCss = readFileSync(`${repoRoot}/web/src/app.css`, 'utf8');
const extCss = readFileSync(`${repoRoot}/extension/src/lib/tokens.css`, 'utf8');

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('%s token block', (_name, selector) => {
  const web = declarations(webCss, selector);
  const ext = declarations(extCss, selector);

  it('declares a non-trivial number of tokens on both sides', () => {
    // Guards the parser itself: a regex that silently matched nothing would
    // make every assertion below pass on two empty maps.
    expect(web.size).toBeGreaterThan(15);
    expect(ext.size).toBeGreaterThan(15);
  });

  it('gives every shared token the same value', () => {
    const mismatched: string[] = [];
    for (const [name, value] of web) {
      const mine = ext.get(name);
      if (mine !== undefined && mine !== value) {
        mismatched.push(`${name}: web ${value} / extension ${mine}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('omits only the tokens it is documented to omit', () => {
    const missing = [...web.keys()].filter((n) => !ext.has(n) && !EXTENSION_OMITS[n]);
    expect(missing).toEqual([]);
  });

  it('adds only the tokens it is documented to add', () => {
    const extra = [...ext.keys()].filter((n) => !web.has(n) && !EXTENSION_ADDS[n]);
    expect(extra).toEqual([]);
  });
});

describe('the shared token file is the extension\u2019s only copy', () => {
  it('does not leave token values behind in the side panel stylesheet', () => {
    const sidepanel = readFileSync(`${repoRoot}/extension/src/sidepanel/app.css`, 'utf8');
    // A `--background`/`--foreground` declaration here means the copy came
    // back: the side panel must reach the values through tokens.css.
    expect(sidepanel).not.toMatch(/--background\s*:/);
    expect(sidepanel).not.toMatch(/--foreground\s*:/);
    expect(sidepanel).toMatch(/@import\s+'\.\.\/lib\/tokens\.css'/);
  });

  it('lets the in-page panel reach the same values', () => {
    const panel = readFileSync(`${repoRoot}/extension/src/content/panel.css`, 'utf8');
    expect(panel).toMatch(/@import\s+'\.\.\/lib\/tokens\.css'/);
    expect(panel).not.toMatch(/--background\s*:/);
  });
});
