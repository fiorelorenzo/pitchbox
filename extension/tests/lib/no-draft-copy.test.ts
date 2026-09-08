import { describe, it, expect } from 'vitest';
import { en } from '../../src/lib/i18n/dict-en.js';
import { it as itDict } from '../../src/lib/i18n/dict-it.js';

// #438: round three of the no-draft copy fix. `dict-it.ts` is type-checked
// (`satisfies Record<keyof typeof en, string>`) to cover every key in
// `dict-en.ts`, and `extension/tests/lib/i18n.test.ts` already exercises
// `translate()`'s runtime fallback for a missing key - neither of those
// proves the two dictionaries carry the *same* `assist.*` key set at
// runtime (the type check only forces IT to be a superset of EN's keys,
// so an IT-only leftover after a rename would type-check but never
// surface here). This file covers only that gap, plus the four contract
// keys and copy-quality rules specific to the no-draft/why disclosure
// strings (#438): no model prose, no em dash, no exclamation mark, and a
// length ceiling that respects the panel's width.

const en_ = en as Record<string, string>;
const it_ = itDict as Record<string, string>;

function assistKeys(dict: Record<string, string>): string[] {
  return Object.keys(dict)
    .filter((k) => k.startsWith('assist.'))
    .sort();
}

// The panel column is narrow (see panel.css); the longest strings already
// shipping on this exact surface top out at 63 characters (IT's
// `assist.refusal.generation_failed`). 70 gives the no-draft title/hint
// pairs a little headroom over that high-water mark while still forcing
// "one or two sentences" rather than the model's own multi-sentence
// reasoning - the whole point of #438.
const NO_DRAFT_CHAR_CEILING = 70;

const CONTRACT_KEYS = [
  'assist.comment.no_draft.skipped.title',
  'assist.comment.no_draft.skipped.hint',
  'assist.comment.no_draft.malformed.title',
  'assist.comment.no_draft.malformed.hint',
] as const;

describe('no-draft and why-disclosure copy (#438)', () => {
  it('both dictionaries carry the four no-draft contract keys', () => {
    for (const key of CONTRACT_KEYS) {
      expect(en_[key], `en.${key}`).toBeTypeOf('string');
      expect(en_[key].length, `en.${key}`).toBeGreaterThan(0);
      expect(it_[key], `it.${key}`).toBeTypeOf('string');
      expect(it_[key].length, `it.${key}`).toBeGreaterThan(0);
    }
  });

  it('both dictionaries carry the why-disclosure keys', () => {
    for (const key of ['assist.comment.why', 'assist.comment.why_skipped']) {
      expect(en_[key], `en.${key}`).toBeTypeOf('string');
      expect(it_[key], `it.${key}`).toBeTypeOf('string');
    }
  });

  it('has identical assist.* key sets across EN and IT', () => {
    expect(assistKeys(it_)).toEqual(assistKeys(en_));
  });

  it('has no em dash or exclamation mark in any assist.* value', () => {
    for (const key of assistKeys(en_)) {
      expect(en_[key], `en.${key}`).not.toMatch(/[—!]/);
    }
    for (const key of assistKeys(it_)) {
      expect(it_[key], `it.${key}`).not.toMatch(/[—!]/);
    }
  });

  it('keeps every no-draft title/hint under the panel-width character ceiling', () => {
    for (const key of CONTRACT_KEYS) {
      expect(en_[key].length, `en.${key} ("${en_[key]}")`).toBeLessThanOrEqual(
        NO_DRAFT_CHAR_CEILING,
      );
      expect(it_[key].length, `it.${key} ("${it_[key]}")`).toBeLessThanOrEqual(
        NO_DRAFT_CHAR_CEILING,
      );
    }
  });
});
