// Minimal hand-rolled i18n. No external deps (no svelte-i18n).
//
// Usage:
//   import { t, locale, setLocale } from '$lib/i18n';
//   $: label = $t('nav.home');           // reactive in Svelte components
//   setLocale('it');                     // switch locale at runtime
//
// Behaviour:
// - Unknown keys fall back to the English dictionary, then to the key itself.
// - Templates support `{name}` placeholders interpolated by `t()`.

import { derived, get, writable, type Readable } from 'svelte/store';
import { DEFAULT_LOCALE, LOCALES, type Dict, type Locale, type TParams } from './types';
import { en } from './dict-en';
import { it } from './dict-it';

export { DEFAULT_LOCALE, LOCALES };
export type { Locale, TParams };

const dictionaries: Record<Locale, Dict> = { en, it };

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

// Reactive active locale. Initialised to the default — server-rendered pages
// can call `setLocale()` from a layout load with the value from
// `app_config.ui_locale`.
export const locale = writable<Locale>(DEFAULT_LOCALE);

export function setLocale(next: Locale | string | null | undefined): void {
  if (isLocale(next)) {
    locale.set(next);
  } else {
    locale.set(DEFAULT_LOCALE);
  }
}

export function getLocale(): Locale {
  return get(locale);
}

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

// Resolve a key against the dictionary for `loc`, falling back to EN, then key.
export function translate(loc: Locale, key: string, params?: TParams): string {
  const primary = dictionaries[loc] ?? dictionaries[DEFAULT_LOCALE];
  const fallback = dictionaries[DEFAULT_LOCALE];
  const template = primary[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}

// Reactive translator. In Svelte components: `{$t('nav.home')}`.
export const t: Readable<(key: string, params?: TParams) => string> = derived(
  locale,
  ($locale) => (key: string, params?: TParams) => translate($locale, key, params),
);

// Non-reactive translator for non-component code (e.g. .ts utilities, tests).
export function tStatic(key: string, params?: TParams): string {
  return translate(getLocale(), key, params);
}
