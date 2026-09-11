/**
 * The dashboard message catalogue (LOR-263), the client-copy counterpart to
 * `shared/src/messages` (the server-sent flat catalogue) and
 * `extension/src/lib/i18n` (the extension's own) - all three share this exact
 * shape (`types.ts`, `dict-en.ts`, `dict-it.ts`, `t()` here) on purpose: one
 * pattern, three catalogues, so a contributor who has read one has read them
 * all. This one differs from the other two in exactly one way: `t()` here
 * takes the already-resolved `Locale` a `.svelte` file reads off
 * `$page.data.locale` (LOR-260) or its own `data.locale` prop - there is no
 * store to subscribe to, since SvelteKit re-renders a component when its
 * props/`$page.data` change, and a second locale store next to that would be
 * the exact "two readers of one preference" drift `AGENTS.md` already warns
 * about for the extension's side panel.
 */
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n.js';
import type { Dict, TParams } from './types.js';
import { en } from './dict-en.js';
import { it } from './dict-it.js';

export { DEFAULT_LOCALE, LOCALES };
export type { Locale, TParams, Dict };

const dictionaries: Record<Locale, Dict> = { en, it };

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Resolves `key` for `locale`. An unresolved locale (a test event, a
 * component rendered before the layout load has run) falls back to
 * `DEFAULT_LOCALE`, and a key missing from that dictionary too returns the
 * bare key rather than throwing - `web/tests/i18n-catalogue.test.ts`'s key-set
 * parity check is what keeps a key from actually going missing, not this
 * function.
 */
export function t(locale: Locale | null | undefined, key: string, params?: TParams): string {
  const primary = dictionaries[locale ?? DEFAULT_LOCALE] ?? dictionaries[DEFAULT_LOCALE];
  const fallback = dictionaries[DEFAULT_LOCALE];
  const template = primary[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}

/**
 * English and Italian share the same two-category CLDR plural rule (`one`
 * for exactly 1, `other` for everything else, including 0) - a count-bearing
 * string is `key.one`/`key.other` rather than its own dictionary entry, and
 * `n` is interpolated automatically alongside any other `params`. Reach for
 * this the moment a template's wording actually changes with the count
 * (`{n} draft` / `{n} drafts` is real English pluralization); a template that
 * merely repeats a fixed noun ("{n} new") never needed a plural key.
 */
export function tn(
  locale: Locale | null | undefined,
  key: string,
  n: number,
  params?: TParams,
): string {
  const suffix = n === 1 ? 'one' : 'other';
  return t(locale, `${key}.${suffix}`, { ...params, n });
}

/**
 * Splits `key`'s resolved template around one `{token}` placeholder into its
 * before/after text, for a sentence that embeds one real Svelte element (an
 * anchor, a styled span around a name) rather than plain text - `t()`'s
 * `interpolate()` only ever produces a string, and `{@html}`-ing a catalogue
 * entry to embed markup would open every string in both dictionaries to
 * injection. `params` interpolates every other placeholder in the template
 * normally; omit `token` from it and `{token}` survives untouched (an unmet
 * placeholder is left as-is), which is what there is left to split on.
 */
export function splitAroundToken(
  locale: Locale | null | undefined,
  key: string,
  token: string,
  params?: TParams,
): [string, string] {
  const resolved = t(locale, key, params);
  const marker = `{${token}}`;
  const idx = resolved.indexOf(marker);
  if (idx === -1) return [resolved, ''];
  return [resolved.slice(0, idx), resolved.slice(idx + marker.length)];
}

/** Every dictionary, for the key-set parity test. */
export const dictionariesForTesting: Record<Locale, Dict> = dictionaries;
