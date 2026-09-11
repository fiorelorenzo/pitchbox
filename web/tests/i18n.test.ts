import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  negotiateLocale,
  parseAcceptLanguage,
  resolveLocale,
} from '../src/lib/i18n.js';

// LOR-260: precedence is the load-bearing part of the locale mechanism, so
// it is what gets tested here. The catalogue/string lookup a later issue
// (LOR-263) builds on top of this is deliberately not - "a string lookup is
// not" worth testing on its own.
describe('negotiateLocale', () => {
  it('picks the highest-quality supported tag from a weighted list', () => {
    expect(negotiateLocale('it;q=0.8, en;q=0.9')).toBe('en');
    expect(negotiateLocale('en;q=0.5, it;q=0.9')).toBe('it');
  });

  it('treats an absent q as the maximum weight (1)', () => {
    expect(negotiateLocale('it, en;q=0.9')).toBe('it');
  });

  it('falls back to English for an unsupported language', () => {
    expect(negotiateLocale('fr-FR,fr;q=0.9')).toBe(DEFAULT_LOCALE);
  });

  it('falls back to English for a malformed header rather than throwing', () => {
    expect(negotiateLocale('not a real header;;;q=nonsense')).toBe(DEFAULT_LOCALE);
    expect(() => negotiateLocale('it;q=5, en;q=-1')).not.toThrow();
    // Both weights are out of the valid [0,1] range and are dropped, so
    // neither tag is ever a candidate.
    expect(negotiateLocale('it;q=5, en;q=-1')).toBe(DEFAULT_LOCALE);
  });

  it('falls back to English when there is no header at all', () => {
    expect(negotiateLocale(null)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('matches region subtags (it-IT, en-GB) to their base language', () => {
    expect(negotiateLocale('it-IT')).toBe('it');
    expect(negotiateLocale('en-GB')).toBe('en');
  });
});

describe('parseAcceptLanguage', () => {
  it('drops an entry whose q is not a real number in [0, 1]', () => {
    expect(parseAcceptLanguage('en;q=abc, it;q=0.5')).toEqual([{ tag: 'it', q: 0.5 }]);
  });

  it('returns an empty list for no header', () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
  });
});

describe('resolveLocale precedence', () => {
  it('an account preference outranks everything else', () => {
    expect(
      resolveLocale({
        accountLocale: 'it',
        cookieLocale: 'en',
        acceptLanguageHeader: 'en-GB',
      }),
    ).toBe('it');
  });

  it('a cookie beats Accept-Language when there is no account preference', () => {
    expect(
      resolveLocale({
        accountLocale: null,
        cookieLocale: 'it',
        acceptLanguageHeader: 'en-GB,en;q=0.9',
      }),
    ).toBe('it');
  });

  it('Accept-Language is used when there is no account preference and no cookie', () => {
    expect(
      resolveLocale({
        accountLocale: undefined,
        cookieLocale: undefined,
        acceptLanguageHeader: 'it-IT,it;q=0.9',
      }),
    ).toBe('it');
  });

  it('an unrecognised cookie value falls through to Accept-Language', () => {
    expect(
      resolveLocale({
        cookieLocale: 'fr',
        acceptLanguageHeader: 'it-IT',
      }),
    ).toBe('it');
  });

  // LOR-262: `accountLocale` is now `users.locale`, an unvalidated DB
  // column rather than a value the type system already narrowed to
  // `Locale` - a stale row (written before 'it' existed, or hand-edited)
  // must fall through exactly like an unrecognised cookie does, never
  // throw and never win outright.
  it('an unrecognised stored account preference falls through to the cookie', () => {
    expect(
      resolveLocale({
        accountLocale: 'fr',
        cookieLocale: 'it',
        acceptLanguageHeader: 'en-GB',
      }),
    ).toBe('it');
  });

  it('falls back to English with no account preference, no cookie, and no header', () => {
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
  });
});
