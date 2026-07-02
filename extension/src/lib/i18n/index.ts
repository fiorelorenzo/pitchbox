import { derived, get, writable, type Readable } from 'svelte/store';
import { DEFAULT_LOCALE, LOCALES, type Dict, type Locale, type TParams } from './types.js';
import { en } from './dict-en.js';
import { it } from './dict-it.js';

export { DEFAULT_LOCALE, LOCALES };
export type { Locale, TParams };

const dictionaries: Record<Locale, Dict> = { en, it };

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

export const locale = writable<Locale>(DEFAULT_LOCALE);

export function setLocale(next: Locale | string | null | undefined): void {
  if (isLocale(next)) locale.set(next);
  else locale.set(DEFAULT_LOCALE);
}

export function getLocale(): Locale {
  return get(locale);
}

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

export function translate(loc: Locale, key: string, params?: TParams): string {
  const primary = dictionaries[loc] ?? dictionaries[DEFAULT_LOCALE];
  const fallback = dictionaries[DEFAULT_LOCALE];
  const template = primary[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}

export const t: Readable<(key: string, params?: TParams) => string> = derived(
  locale,
  ($loc) => (key: string, params?: TParams) => translate($loc, key, params),
);

/**
 * Resolve the initial locale at boot:
 *   1. user preference in chrome.storage.local.extensionSettings.locale, then
 *   2. chrome.i18n.getUILanguage() - `it*` → 'it', else 'en'.
 */
export async function resolveInitialLocale(): Promise<Locale> {
  try {
    const out = (await chrome.storage.local.get('extensionSettings')) as {
      extensionSettings?: { locale?: string };
    };
    const stored = out.extensionSettings?.locale;
    if (isLocale(stored)) return stored;
  } catch {
    // chrome.storage may be unavailable in tests; fall through.
  }
  try {
    const ui = chrome.i18n?.getUILanguage?.() ?? 'en';
    return ui.toLowerCase().startsWith('it') ? 'it' : 'en';
  } catch {
    return 'en';
  }
}
