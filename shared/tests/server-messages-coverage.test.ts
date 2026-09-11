import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../src/messages/dict-en.js';
import { it as itDict } from '../src/messages/dict-it.js';

/**
 * LOR-264: every `t(locale, 'some.key', ...)` call reachable from a server
 * route or an outbound mail template must resolve in both dictionaries to a
 * real sentence, not a fallback to the bare key - the same shape
 * `extension/tests/lib/activity-i18n-coverage.test.ts` already enforces for
 * the extension's own catalogue. Scanned from source rather than
 * hand-listed, so a call site that forgets to add its translation fails
 * here instead of shipping a raw key (or English) to an Italian request.
 */
const SCAN_ROOTS = [
  fileURLToPath(new URL('../../web/src/routes/api', import.meta.url)),
  fileURLToPath(new URL('../../web/src/lib/server', import.meta.url)),
  fileURLToPath(new URL('../src/mail', import.meta.url)),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// The one dynamic key in the codebase: extraction-uploads' `bad_path`
// message composes `api.uploads.reason.${v.reason}` from `BadPathReason`'s
// own literal union, which a plain string-literal scan can't see through.
// Expanded here rather than pattern-matched, so a new reason code added to
// that union without a matching translation still has to be added here too.
const DYNAMIC_REASON_CODES = [
  'empty_path',
  'absolute_path',
  'invalid_characters',
  'parent_traversal',
  'path_too_long',
];

function scanEmittedKeys(): string[] {
  const keys = new Set<string>();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*[^,()]+,\s*'([a-z0-9_.]+)'/g)) {
        keys.add(m[1]);
      }
      if (text.includes('api.uploads.reason.${')) {
        for (const code of DYNAMIC_REASON_CODES) keys.add(`api.uploads.reason.${code}`);
      }
    }
  }
  return [...keys].sort();
}

describe('server message key coverage', () => {
  const emitted = scanEmittedKeys();

  it('scans a realistic number of message keys out of the sources', () => {
    // Guards the scanner itself: a directory-layout change must not
    // silently start matching nothing and pass every assertion below
    // vacuously.
    expect(emitted.length).toBeGreaterThanOrEqual(15);
  });

  it('every emitted key has an EN sentence, not a bare-key fallback', () => {
    const dict = en as Record<string, string>;
    const missing = emitted.filter((k) => !(k in dict));
    expect(missing, `dict-en.ts is missing: ${missing.join(', ')}`).toEqual([]);
    const bare = emitted.filter((k) => dict[k] === k);
    expect(bare, `dict-en.ts entries that just echo the key: ${bare.join(', ')}`).toEqual([]);
  });

  it('every emitted key has an IT sentence, not a bare-key fallback', () => {
    const dict = itDict as Record<string, string>;
    const missing = emitted.filter((k) => !(k in dict));
    expect(missing, `dict-it.ts is missing: ${missing.join(', ')}`).toEqual([]);
    const bare = emitted.filter((k) => dict[k] === k);
    expect(bare, `dict-it.ts entries that just echo the key: ${bare.join(', ')}`).toEqual([]);
  });

  it('the two dictionaries carry exactly the same key set', () => {
    const enKeys = Object.keys(en).sort();
    const itKeys = Object.keys(itDict).sort();
    expect(itKeys).toEqual(enKeys);
  });

  it('no EN sentence for an emitted key is byte-identical to its IT translation', () => {
    // A genuine catalogue miss for one specific locale (copy-pasted the
    // English string as a placeholder) reads as "both dictionaries have the
    // key" and would slip past the two checks above.
    const identical = emitted.filter(
      (k) => en[k as keyof typeof en] === itDict[k as keyof typeof itDict],
    );
    expect(identical, `same sentence in both locales: ${identical.join(', ')}`).toEqual([]);
  });
});
