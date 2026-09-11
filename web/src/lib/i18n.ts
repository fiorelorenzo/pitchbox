/**
 * The dashboard's locale seam (LOR-260). One locale is resolved per request,
 * once, in `hooks.server.ts`, and read from `event.locals.locale` by every
 * loader and every component from there - no page decides on its own, and
 * no page can disagree with another.
 *
 * `pitchbox-landing`'s `$lib/i18n.ts` is the reference this follows
 * (path-based: `/` is English, `/it` is Italian). The dashboard takes one
 * deliberate difference, recorded in `docs/design/DECISIONS.md` D46: it is
 * authenticated, so the override is a property of the *account* rather than
 * the URL, and the locale never touches the path. That keeps every one of
 * the ~50 existing authenticated routes exactly where it is - including the
 * `/settings/status` and `/contacts` deep links the extension already holds
 * - and it is what lets the extension later read the same preference
 * through its pairing instead of keeping a second, independent one
 * (LOR-262).
 *
 * Resolution order, load-bearing and worth testing on its own
 * (`web/tests/i18n.test.ts`):
 *   1. the signed-in user's stored preference (`accountLocale` below);
 *   2. the `pitchbox_locale` cookie - the pre-login fallback, since
 *      `/login`, `/register`, `/invite/[token]` and `/reset` are read by
 *      someone who has no account yet;
 *   3. `Accept-Language`, negotiated against the supported set;
 *   4. English.
 *
 * `accountLocale` is `users.locale` (LOR-262), read alongside the rest of
 * the session by `shared/src/auth.ts`'s `loadSession` and passed in at
 * `hooks.server.ts`'s call site - this module's precedence did not change
 * when the data source landed, only where the value comes from.
 *
 * The language of *this* interface is a different axis from the language a
 * *draft* is written in (`shared/src/assist/voice-profile.ts`'s
 * `classifyLanguage`) - conflating the two is the failure mode LOR-266
 * exists to document, and this module never reads or writes draft content.
 */

export type Locale = 'en' | 'it';

export const LOCALES: readonly Locale[] = ['en', 'it'];

export const DEFAULT_LOCALE: Locale = 'en';

/** The cookie the pre-login pages fall back to before there is an account
 * to hold a preference. Ranked under an account preference once LOR-262
 * exists (see `resolveLocale`). */
export const LOCALE_COOKIE = 'pitchbox_locale';

function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'it';
}

/** One `Accept-Language` entry, tag lowercased, with its RFC 7231 `q` weight
 * (default 1 when absent). Never throws: a fragment whose weight is not a
 * real number in [0, 1] is dropped rather than crashing the request, and no
 * header at all parses to no preference. Copied from
 * `pitchbox-landing/src/hooks.server.ts`'s `parseAcceptLanguage`, the
 * reference this issue follows. */
export function parseAcceptLanguage(
  header: string | null | undefined,
): Array<{ tag: string; q: number }> {
  if (!header) return [];
  const weights: Array<{ tag: string; q: number }> = [];
  for (const entry of header.split(',')) {
    const [tagPart, ...params] = entry.split(';');
    const tag = tagPart?.trim().toLowerCase();
    if (!tag) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    let q = 1;
    if (qParam) {
      const value = Number(qParam.slice(2));
      if (!Number.isFinite(value) || value < 0 || value > 1) continue;
      q = value;
    }
    weights.push({ tag, q });
  }
  return weights;
}

/** The highest-quality tag that maps to a supported locale wins. A header
 * with nothing parseable, only unrelated tags, a malformed weight on every
 * entry, or no header at all falls back to `DEFAULT_LOCALE` rather than
 * guessing. */
export function negotiateLocale(header: string | null | undefined): Locale {
  let best: { locale: Locale; q: number } | null = null;
  for (const { tag, q } of parseAcceptLanguage(header)) {
    const locale: Locale | null =
      tag === 'it' || tag.startsWith('it-')
        ? 'it'
        : tag === 'en' || tag.startsWith('en-')
          ? 'en'
          : null;
    if (locale && (!best || q > best.q)) best = { locale, q };
  }
  return best?.locale ?? DEFAULT_LOCALE;
}

export interface LocaleResolutionInput {
  /**
   * The signed-in user's stored preference (LOR-262: `users.locale`, a raw
   * DB column, not the `Locale` type - hence `string`, matching
   * `cookieLocale` below rather than looking pre-validated). `undefined`/
   * `null` for a signed-out visitor, self-host with auth off, or a user
   * who has never set one - each of those falls through to the cookie.
   * An unrecognised stored value (a row written before 'it' existed, a
   * hand-edited one) falls through the same way an unrecognised cookie
   * does, via the `isLocale` check below - never thrown, never trusted
   * outright.
   */
  accountLocale?: string | null;
  /** `event.cookies.get(LOCALE_COOKIE)` - a string, since a cookie value is
   * never typed, or absent entirely. */
  cookieLocale?: string | null;
  /** The raw `accept-language` request header, or absent entirely. */
  acceptLanguageHeader?: string | null;
}

/** The one place the four-step precedence documented above is decided. */
export function resolveLocale(input: LocaleResolutionInput): Locale {
  if (isLocale(input.accountLocale)) return input.accountLocale;
  if (isLocale(input.cookieLocale)) return input.cookieLocale;
  return negotiateLocale(input.acceptLanguageHeader);
}
