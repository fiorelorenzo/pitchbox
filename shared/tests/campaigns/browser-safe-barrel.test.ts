import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as barrel from '../../src/campaigns/index.js';
import { deleteCampaign } from '../../src/campaigns/server.js';

// `@pitchbox/shared/campaigns` is imported by Svelte components (the campaign
// page pulls platformSupportsAutoPost out of it), so it is part of the CLIENT
// bundle. Re-exporting anything that reaches `db/client` drags drizzle + pg in
// there, and the page dies at hydration with "Buffer is not defined" while SSR
// still looks fine - which is exactly how it slipped through once. Server-only
// campaign helpers belong in `campaigns/server.ts`.
const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const BARREL = resolve(SRC, 'campaigns/index.ts');

function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      // Source is .ts; the specifiers are written with the emitted .js suffix.
      queue.push(resolve(dirname(file), m[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return [...seen];
}

describe('campaigns barrel stays browser-safe', () => {
  it('never reaches the database client', () => {
    const offenders = reachableFrom(BARREL)
      .filter((f) => f.includes(`${SRC}/db/`))
      .map((f) => relative(SRC, f));
    expect(offenders, 'move these behind @pitchbox/shared/campaigns/server').toEqual([]);
  });

  it('keeps the server-only helpers out of the barrel', () => {
    expect('deleteCampaign' in barrel).toBe(false);
    // ...but they are reachable on their own subpath.
    expect(typeof deleteCampaign).toBe('function');
  });
});
