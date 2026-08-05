import { describe, it, expect } from 'vitest';
import { translate, DEFAULT_LOCALE, LOCALES } from '../../src/lib/i18n/index.js';
import { it as itDict } from '../../src/lib/i18n/dict-it.js';

describe('i18n', () => {
  it('exposes en + it locales', () => {
    expect(LOCALES).toEqual(['en', 'it']);
    expect(DEFAULT_LOCALE).toBe('en');
  });
  it('translates known keys', () => {
    expect(translate('en', 'nav.dashboard')).toBe('Dashboard');
    expect(translate('it', 'nav.dashboard')).toBe('Dashboard');
  });
  it('falls back to EN when a key is missing in IT', () => {
    // dict-it is type-checked to always cover every dict-en key (see
    // dict-it.ts), so simulate a runtime gap instead of shipping a
    // permanently mismatched fixture key just to exercise the fallback.
    const dict = itDict as Record<string, string>;
    const original = dict['nav.activity'];
    delete dict['nav.activity'];
    try {
      expect(translate('it', 'nav.activity')).toBe('Activity');
    } finally {
      dict['nav.activity'] = original;
    }
  });
  it('falls back to the key itself when missing in both', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
  it('interpolates {name} placeholders', () => {
    expect(translate('en', 'activity.dm-sync.ok', { inserted: 3, replied: 1 })).toBe(
      'Reddit inbox sync - 3 new, 1 replied.',
    );
  });
});
