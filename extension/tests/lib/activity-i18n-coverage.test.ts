import { describe, expect, it } from 'vitest';
import { en } from '../../src/lib/i18n/dict-en.js';
import { it as itDict } from '../../src/lib/i18n/dict-it.js';

// #403: an `ActivityEvent.message` that has no dictionary entry renders as
// its raw key (see `translate()`'s `?? key` fallback in `lib/i18n/index.ts`)
// instead of a sentence, and the params silently vanish because nothing in
// the raw key has a `{placeholder}` to catch them. This test enumerates
// every `activity.<source>.<event>` key the extension can actually emit -
// by scanning the sources, not by hand-listing them here - and fails if
// either dictionary is missing one.
//
// Read via Vite's raw glob import rather than `node:fs`: the extension
// tsconfig's `types` is deliberately narrow (chrome/vite/svelte only, see
// its own comment) and excludes ambient Node globals, and pulling those in
// just for this file would reopen the DOM/Node `setTimeout` type clash that
// narrow list exists to avoid.
const sourceFiles = import.meta.glob('../../src/**/*.{ts,svelte}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

// `ActivitySource` (`lib/activity.ts`) is the source of truth for which
// `activity.<x>.*` keys are real event messages, as opposed to UI-chrome
// keys that also live under the `activity.` namespace (`activity.level.*`,
// `activity.filter.*`, `activity.actions.*`, ...): those never appear as
// the first segment after `activity.` here, so scoping the scan to known
// sources excludes them without a hand-picked denylist.
function readActivitySources(): string[] {
  const activityTsPath = Object.keys(sourceFiles).find((p) => p.endsWith('/lib/activity.ts'));
  if (!activityTsPath) throw new Error('could not find lib/activity.ts among the scanned sources');
  const text = sourceFiles[activityTsPath];
  const match = text.match(/export type ActivitySource =([^;]+);/);
  if (!match) throw new Error('could not find the ActivitySource union in lib/activity.ts');
  return [...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

// Every `activity.<source>.<event>` literal in the source tree, wherever it
// appears (an `ActivityEvent.message` field, a helper that takes the key as
// a plain string argument, and so on) - the dictionaries themselves are
// excluded since they declare translations rather than emit events.
function scanEmittedActivityKeys(): string[] {
  const sources = readActivitySources();
  const pattern = /activity\.([a-z0-9-]+)\.([a-z0-9-]+)/g;
  const keys = new Set<string>();
  for (const [path, text] of Object.entries(sourceFiles)) {
    if (path.endsWith('/i18n/dict-en.ts') || path.endsWith('/i18n/dict-it.ts')) continue;
    for (const m of text.matchAll(pattern)) {
      if (sources.includes(m[1])) keys.add(m[0]);
    }
  }
  return [...keys].sort();
}

describe('activity message key coverage', () => {
  const emitted = scanEmittedActivityKeys();

  it('scans a realistic number of activity.* event keys out of the sources', () => {
    // Guards the scanner itself: a change to activity.ts's union shape or
    // to the file layout it walks must not silently start matching nothing
    // and pass vacuously.
    expect(emitted.length).toBeGreaterThan(30);
  });

  it('every emitted activity.* key has an EN sentence', () => {
    const dict = en as Record<string, string>;
    const missing = emitted.filter((k) => !(k in dict));
    expect(missing, `dict-en.ts is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('every emitted activity.* key has an IT sentence', () => {
    const dict = itDict as Record<string, string>;
    const missing = emitted.filter((k) => !(k in dict));
    expect(missing, `dict-it.ts is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('no EN entry for an emitted key is still the bare key (a real sentence, not a fallback)', () => {
    const dict = en as Record<string, string>;
    const bare = emitted.filter((k) => dict[k] === k);
    expect(bare, `dict-en.ts entries that just echo the key: ${bare.join(', ')}`).toEqual([]);
  });
});
