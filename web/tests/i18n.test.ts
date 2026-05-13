import { describe, expect, it, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  DEFAULT_LOCALE,
  LOCALES,
  getLocale,
  locale,
  setLocale,
  t,
  translate,
  tStatic,
} from '../src/lib/i18n/index.js';

describe('i18n', () => {
  beforeEach(() => {
    // Reset to the default locale between tests to keep them independent.
    setLocale(DEFAULT_LOCALE);
  });

  it('exposes the supported locales', () => {
    expect(LOCALES).toContain('en');
    expect(LOCALES).toContain('it');
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('returns the English translation by default', () => {
    expect(translate('en', 'nav.inbox')).toBe('Inbox');
    expect(translate('en', 'inbox.empty')).toBe('No drafts to review');
    expect(translate('en', 'login.title')).toBe('Sign in');
  });

  it('returns the Italian translation when the locale is "it"', () => {
    expect(translate('it', 'nav.inbox')).toBe('Posta in arrivo');
    expect(translate('it', 'inbox.empty')).toBe('Nessuna bozza da rivedere');
    expect(translate('it', 'login.title')).toBe('Accedi');
  });

  it('falls back to English for keys missing in a non-default locale', () => {
    // Sanity-check: assume `nav.home` is identical, but the contract is:
    // missing keys in `it` should resolve via EN, never throw.
    expect(translate('it', 'nav.home')).toBe('Home');
  });

  it('returns the key itself for unknown keys (no throw)', () => {
    expect(translate('en', 'totally.unknown.key')).toBe('totally.unknown.key');
    expect(translate('it', 'totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('interpolates {name}-style params', () => {
    // Use a key that doesn't exist so the template falls back to the key —
    // this also verifies interpolation runs on the fallback path.
    expect(translate('en', 'Hello, {name}!', { name: 'Ada' })).toBe('Hello, Ada!');
    // Missing params leave the placeholder untouched.
    expect(translate('en', 'Hello, {name}!')).toBe('Hello, {name}!');
  });

  it('updates the reactive store when setLocale() is called', () => {
    const tFn = get(t);
    expect(tFn('nav.inbox')).toBe('Inbox');

    setLocale('it');
    expect(getLocale()).toBe('it');
    expect(get(locale)).toBe('it');
    const tFnIt = get(t);
    expect(tFnIt('nav.inbox')).toBe('Posta in arrivo');
  });

  it('coerces invalid locale values back to the default', () => {
    setLocale('it');
    setLocale('xx');
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });

  it('tStatic() reads the current locale', () => {
    expect(tStatic('nav.settings')).toBe('Settings');
    setLocale('it');
    expect(tStatic('nav.settings')).toBe('Impostazioni');
  });
});
