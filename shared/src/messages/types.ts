// Shared shape for the server-message catalogue (LOR-264): the flat-key
// dictionary the extension's own `src/lib/i18n/types.ts` already uses for the
// same reason - a plain object indexed by a dotted key needs no schema, and a
// missing key is caught by `shared/tests/server-messages-coverage.test.ts`
// rather than a type error. Deliberately its own type, not an import of
// `web/src/lib/i18n.ts`'s `Locale`: `shared/` never depends on `web/`, and the
// two types are structurally identical (`'en' | 'it'`), so a value produced by
// either resolver passes to `t()` without a cast.
export const LOCALES = ['en', 'it'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export type Dict = Record<string, string>;
export type MessageParams = Record<string, string | number>;
