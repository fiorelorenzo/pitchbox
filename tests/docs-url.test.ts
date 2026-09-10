import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The docs site moved twice (D25 to GitHub Pages, D38 to `docs.pitchbox.app`)
 * and both times a link in the app kept pointing at the old address, because
 * the URL was a literal pasted into whichever component needed it. LOR-209
 * collapsed it into `web/src/lib/config/docs.ts`; this keeps it collapsed and
 * keeps the retired host out of the shipped code.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SCANNED = ['web/src', 'extension/src', 'daemon/src', 'shared/src', 'cli/src'];
const RETIRED_HOST = 'fiorelorenzo.github.io';
const DOCS_HOST = 'docs.pitchbox.app';

/** Every source file under `dir`, repo-relative, with its contents. */
function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|js|svelte|css|html|json)$/.test(entry.name)) continue;
      out.push({ file: path.relative(repoRoot, child), text: readFileSync(child, 'utf8') });
    }
  };
  walk(path.join(repoRoot, dir));
  return out;
}

const files = SCANNED.flatMap(sources);

describe('the documentation URL', () => {
  it('never names the retired GitHub Pages host', () => {
    const offenders = files.filter((f) => f.text.includes(RETIRED_HOST)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('is defined once, in web/src/lib/config/docs.ts', () => {
    const holders = files.filter((f) => f.text.includes(DOCS_HOST)).map((f) => f.file);
    expect(holders).toEqual(['web/src/lib/config/docs.ts']);
  });

  it('ends both of its URLs in a slash, since callers concatenate a page path', () => {
    const module = readFileSync(path.join(repoRoot, 'web/src/lib/config/docs.ts'), 'utf8');
    const urls = [...module.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(`${url}auth`).toBe(new URL('auth', url).href);
  });
});
