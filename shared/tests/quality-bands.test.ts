import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_RUBRIC,
  DETERMINISTIC_QUALITY_MODEL,
  scoreBand,
} from '../src/quality-bands.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every module `quality-bands.ts` can reach, following relative imports. */
function transitiveLocalImports(entry: string): string[] {
  const seen = new Set<string>();
  const external: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const spec = match[1]!;
      if (spec.startsWith('.')) {
        walk(join(dirname(file), spec.replace(/\.js$/, '.ts')));
      } else {
        external.push(spec);
      }
    }
  };
  walk(entry);
  return external;
}

describe('quality-bands is safe to import from a browser bundle', () => {
  // The regression this pins, found on merged main on 2026-09-11 and on no
  // single branch: DraftListItem and DraftDetail imported `scoreBand` from
  // `quality-judge.ts`, which had grown top-level imports of `ai`,
  // `@ai-sdk/gateway` and the pg-backed voice profile. The server stack
  // went into the client bundle, the Inbox failed to hydrate, and the page
  // rendered "500 Internal Error" while its own server-rendered HTML was
  // correct. Nothing short of loading the page could see it.
  it('reaches no dependency at all, directly or transitively', () => {
    expect(transitiveLocalImports(join(SRC, 'quality-bands.ts'))).toEqual([]);
  });

  it('scoreBand reports an unmeasured draft as none rather than as bad', () => {
    expect(scoreBand(null, DEFAULT_QUALITY_RUBRIC)).toBe('none');
    expect(scoreBand(undefined, DEFAULT_QUALITY_RUBRIC)).toBe('none');
    expect(scoreBand(0, DEFAULT_QUALITY_RUBRIC)).toBe('red');
  });

  it('bands split on the rubric thresholds, inclusive at green', () => {
    const r = DEFAULT_QUALITY_RUBRIC;
    expect(scoreBand(r.threshold_red - 1, r)).toBe('red');
    expect(scoreBand(r.threshold_red, r)).toBe('amber');
    expect(scoreBand(r.threshold_green - 1, r)).toBe('amber');
    expect(scoreBand(r.threshold_green, r)).toBe('green');
  });

  it('the deterministic sentinel can never collide with a gateway model id', () => {
    expect(DETERMINISTIC_QUALITY_MODEL).not.toContain('/');
  });
});
