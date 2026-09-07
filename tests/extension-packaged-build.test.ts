import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Invariants that only exist in the packaged build, which is exactly where
 * #379's first three defects lived: every one of them was invisible under
 * `vite dev` and shipped anyway.
 *
 *  - An inline `<script>` in an extension page is refused by MV3's
 *    `script-src 'self'` CSP, so it never runs and every open logs an error.
 *  - A runtime script path pointing at a `.ts` source file resolves while Vite
 *    serves the source and never in `dist`, so `chrome.scripting` rejects and
 *    the feature reports a misleading failure (pairing said "No Pitchbox
 *    dashboard found in that tab").
 *
 * This builds the extension for real rather than reading the source, because
 * the artifact is the thing that was wrong. It is the slowest test in the
 * suite by design.
 */

const EXT_ROOT = path.resolve(import.meta.dirname, '../extension');
const DIST = path.join(EXT_ROOT, 'dist');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let files: string[] = [];

beforeAll(() => {
  execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: EXT_ROOT, stdio: 'pipe' });
  files = walk(DIST);
}, 300_000);

describe('the packaged extension', () => {
  it('emits the pages and content scripts the manifest and registrations name', () => {
    expect(existsSync(path.join(DIST, 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(DIST, 'src/sidepanel/index.html'))).toBe(true);
    for (const script of [
      'auto-pair.js',
      'linkedin-comment.js',
      'linkedin-observe.js',
      'linkedin-reply-ingest.js',
      'linkedin-comment-assist.js',
      'linkedin-post-assist.js',
    ]) {
      expect(existsSync(path.join(DIST, 'src/content', script)), script).toBe(true);
    }
  });

  it('has no inline script in any page, which MV3 refuses to execute', () => {
    for (const file of files.filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(file, 'utf8');
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]);
      expect(inline, path.relative(DIST, file)).toEqual([]);
    }
  });

  it('hands chrome.scripting only paths that exist in the build', () => {
    // The literals inside a `files:`/`js:` array are the script paths Chrome
    // is asked to inject or register. A source `.ts` path lands here when the
    // code was only ever exercised under `vite dev`, and Chrome answers with a
    // rejection the caller usually reports as something else entirely. Bare
    // identifiers are skipped: those are the `?script`/`?iife` imports, whose
    // value is checked by the emitted-files assertion above.
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      const js = readFileSync(file, 'utf8');
      for (const call of js.matchAll(/\b(?:files|js)\s*:\s*\[([^\]]{0,400})\]/g)) {
        for (const literal of call[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
          if (existsSync(path.join(DIST, literal[1]))) continue;
          offenders.push(`${path.relative(DIST, file)}: ${literal[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the injectable auto-pair script self-contained, so a second injection still runs', () => {
    // crxjs's `?script` output is an ESM loader that dynamic-imports the real
    // chunk. Modules are cached per document and the dashboard's declared
    // content script has already imported that chunk, so injecting the loader
    // again resolves without executing anything - a silent no-op that read as
    // "no dashboard in that tab". An IIFE has no import to be cached.
    const js = readFileSync(path.join(DIST, 'src/content/auto-pair.js'), 'utf8');
    expect(js).not.toMatch(/\bimport\s*\(/);
    expect(js).toContain('/api/extension/auto-pair');
  });
});
