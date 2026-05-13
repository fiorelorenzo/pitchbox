import { describe, it, expect } from 'vitest';
import { translate, DEFAULT_LOCALE, LOCALES } from '../../src/lib/i18n/index.js';

describe('i18n', () => {
  it('exposes en + it locales', () => {
    expect(LOCALES).toEqual(['en', 'it']);
    expect(DEFAULT_LOCALE).toBe('en');
  });
  it('translates known keys', () => {
    expect(translate('en', 'nav.dashboard')).toBe('Dashboard');
    expect(translate('it', 'nav.dashboard')).toBe('Dashboard');
  });
  it('falls back to EN when key missing in IT', () => {
    // Use a key we will only define in EN (added in this task).
    expect(translate('it', 'test.only-en')).toBe('only english');
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
