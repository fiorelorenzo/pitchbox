import { DEFAULT_LOCALE, LOCALES, type Dict, type Locale, type MessageParams } from './types.js';
import { en } from './dict-en.js';
import { it } from './dict-it.js';

export { DEFAULT_LOCALE, LOCALES };
export type { Locale, MessageParams };

const dictionaries: Record<Locale, Dict> = { en, it };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Resolves `key` for `locale`, mirroring the extension's own
 * `src/lib/i18n/index.ts` `translate()`: an unresolved locale (a stale
 * client, a test event with no `locals.locale`) falls back to
 * `DEFAULT_LOCALE`, and a key missing from that dictionary too returns the
 * bare key rather than throwing - `server-messages-coverage.test.ts` is what
 * keeps a key from actually going missing, not this function.
 */
export function t(locale: Locale | null | undefined, key: string, params?: MessageParams): string {
  const primary = dictionaries[locale ?? DEFAULT_LOCALE] ?? dictionaries[DEFAULT_LOCALE];
  const fallback = dictionaries[DEFAULT_LOCALE];
  const template = primary[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}

/** Every dictionary, for coverage tests that need to diff key sets. */
export const dictionariesForTesting: Record<Locale, Dict> = dictionaries;
