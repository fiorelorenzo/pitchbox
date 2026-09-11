/**
 * The dashboard catalogue's own guard rails (LOR-263).
 *
 * `t()` returns the bare key when a key is missing from every dictionary,
 * which is the right runtime behaviour (a missing string must never throw in
 * front of a user) and exactly why it cannot be the thing that catches a
 * missing translation. These two tests are.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, dictionariesForTesting, t, tn } from '../src/lib/i18n/index.js';

describe('the dashboard message catalogue', () => {
  it('has the same key set in every locale', () => {
    const reference = Object.keys(dictionariesForTesting[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const keys = Object.keys(dictionariesForTesting[locale]).sort();
      const missing = reference.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !reference.includes(k));
      expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] });
    }
  });

  it('translates every key rather than carrying the English string twice', () => {
    // A handful of entries are legitimately identical across both languages:
    // product and platform nouns, a bare placeholder, a unit. Anything else
    // sharing its English text is an untranslated key that the parity test
    // above cannot see, since the key is present in both dictionaries.
    const identical: string[] = [];
    const en = dictionariesForTesting.en;
    for (const [key, value] of Object.entries(en)) {
      for (const locale of LOCALES) {
        if (locale === DEFAULT_LOCALE) continue;
        if (dictionariesForTesting[locale][key] === value) identical.push(key);
      }
    }
    // Not an assertion on a count, which would need editing on every
    // legitimate addition: each of these must be a string a reader would
    // write the same way in both languages.
    const suspicious = identical.filter((k) => {
      const v = en[k];
      // A word or two (a proper noun, a unit, a platform name) can match; a
      // sentence matching is an untranslated sentence.
      return v.trim().split(/\s+/).length > 3;
    });
    expect(suspicious).toEqual([]);
  });

  it('interpolates params and leaves an unmet placeholder visible', () => {
    const dict = dictionariesForTesting.en;
    const withParam = Object.entries(dict).find(([, v]) => /\{\w+\}/.test(v));
    expect(withParam, 'the catalogue should carry at least one interpolated string').toBeTruthy();
    const [key, template] = withParam!;
    const name = /\{(\w+)\}/.exec(template)![1];
    expect(t('en', key, { [name]: 'VALUE' })).toContain('VALUE');
    expect(t('en', key)).toContain(`{${name}}`);
  });

  it('picks the plural branch by count, in both locales', () => {
    const pluralKeys = Object.keys(dictionariesForTesting.en)
      .filter((k) => k.endsWith('.one'))
      .map((k) => k.slice(0, -'.one'.length));
    for (const base of pluralKeys) {
      for (const locale of LOCALES) {
        const one = dictionariesForTesting[locale][`${base}.one`];
        const other = dictionariesForTesting[locale][`${base}.other`];
        expect(tn(locale, base, 1)).toBe(one.replaceAll('{n}', '1'));
        expect(tn(locale, base, 0)).toBe(other.replaceAll('{n}', '0'));
        expect(tn(locale, base, 7)).toBe(other.replaceAll('{n}', '7'));
      }
    }
  });
});
