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

const OVERRIDE_BACKEND = 'https://preview-invariant.pitchbox.app';
// Pinned rather than left to the checkout's own commit, so the assertion
// below is about the stamping and not about what HEAD happens to be.
const BUILD_ID = 'test-build-id';

beforeAll(() => {
  // Built with the override set, so the same run proves both that the
  // artifacts exist and that a self-hosted or preview build actually points
  // where it was told to (#445: the documented variable was silently
  // dropped, and every build carried the production default).
  execFileSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: EXT_ROOT,
    stdio: 'pipe',
    env: {
      ...process.env,
      VITE_DEFAULT_BACKEND_URL: OVERRIDE_BACKEND,
      PITCHBOX_BUILD_ID: BUILD_ID,
    },
  });
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
      'linkedin-profile-capture.js',
      'linkedin-source-capture.js',
    ]) {
      expect(existsSync(path.join(DIST, 'src/content', script)), script).toBe(true);
    }
  });

  it('carries app.pitchbox.app in host_permissions and the auto-pair matches (#424)', () => {
    // A manifest missing the new host means a fresh install never zero-click
    // pairs there: the auto-pair content script simply never runs on the
    // page, and the only symptom is the manual "Pair with this tab" button
    // instead of any error. The apex/www stay listed too, transitionally,
    // for an install already paired against the old host.
    const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as {
      host_permissions: string[];
      content_scripts: { js: string[]; matches: string[] }[];
    };
    expect(manifest.host_permissions).toContain('https://app.pitchbox.app/*');
    expect(manifest.host_permissions).toContain('https://pitchbox.app/*');

    const autoPair = manifest.content_scripts.find((cs) =>
      cs.js.some((f) => f.includes('auto-pair')),
    );
    expect(autoPair, 'auto-pair content script entry').toBeDefined();
    expect(autoPair!.matches).toContain('https://app.pitchbox.app/*');
    expect(autoPair!.matches).toContain('https://pitchbox.app/*');
  });

  it('registers every dynamic content script as a standalone file, never as a module chunk', () => {
    // The fourth way this class of defect ships, found on 2026-09-07 while
    // adding the persona capture (#389): a new content script that is not in
    // `vite.config.ts`'s `contentScripts.standaloneFiles` still builds, and
    // its `?script` import still resolves, but to an ES module chunk under
    // `assets/`. A dynamically-registered MV3 content script cannot be a
    // module, so `chrome.scripting.registerContentScripts` rejects it at
    // runtime and the feature is simply absent - which is what #379 looked
    // like from the outside.
    //
    // So: every `src/content/*.js` path the built service worker names must
    // exist AND be free of module syntax. The `assets/` path shape is what a
    // missing `standaloneFiles` entry produces, and it is caught by the
    // existence half.
    const background = files.find(
      (f) => f.includes('background') && f.endsWith('.js') && f.includes('assets'),
    );
    expect(background, 'built service worker').toBeTruthy();
    const workerJs = readFileSync(background as string, 'utf8');
    const referenced = new Set(
      [...workerJs.matchAll(/["'`](src\/content\/[A-Za-z0-9._-]+\.js)["'`]/g)].map((m) => m[1]),
    );
    // The registrations under `extension/src/background/` all go through this
    // worker, so an empty set means the extraction broke, not that there is
    // nothing to check.
    expect(referenced.size).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const rel of referenced) {
      const abs = path.join(DIST, rel);
      if (!existsSync(abs)) {
        offenders.push(`${rel}: registered but not emitted`);
        continue;
      }
      const js = readFileSync(abs, 'utf8');
      if (/^\s*import\s.+\sfrom\s|^\s*export\s/m.test(js)) {
        offenders.push(`${rel}: emitted as a module, cannot be registered`);
      }
    }
    expect(offenders).toEqual([]);
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

  it('bakes the requested default backend into the build, not the production fallback', () => {
    // #445: `VITE_DEFAULT_BACKEND_URL` was passed as a
    // `import.meta.env.VITE_*` define, which Vite fills from `.env` files
    // instead, so the override was dropped and every artifact carried
    // `https://pitchbox.app`. A preview install still reached preview because
    // its pairing named the backend explicitly, which is what hid this: the
    // default only decides where a fresh, unpaired install talks.
    const carriers = files.filter(
      (f) => f.endsWith('.js') && readFileSync(f, 'utf8').includes(OVERRIDE_BACKEND),
    );
    expect(carriers.map((f) => path.relative(DIST, f)).length).toBeGreaterThan(0);
  });

  it('stamps the build it was made from, so two bundles of one version differ', () => {
    // The manifest version only moves on a release commit, so every bundle
    // between two releases reported the same `0.17.0` in chrome://extensions
    // with nothing else to go on. On 2026-09-10 a bundle built before a fix
    // merged was judged as if it contained it, twice.
    const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as {
      version: string;
      version_name?: string;
    };
    expect(manifest.version_name).toBe(`${manifest.version} (${BUILD_ID})`);

    // And the side panel says the same thing, so the answer is reachable
    // without opening chrome://extensions.
    const carriers = files.filter(
      (f) =>
        f.endsWith('.js') && readFileSync(f, 'utf8').includes(`${manifest.version} (${BUILD_ID})`),
    );
    expect(carriers.length).toBeGreaterThan(0);
  });
});
