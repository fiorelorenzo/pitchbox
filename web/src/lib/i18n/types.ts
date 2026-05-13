// i18n types. Keep dictionaries flat (dotted keys) for easy grepping.

export type Locale = 'en' | 'it';

export const LOCALES: readonly Locale[] = ['en', 'it'] as const;

export const DEFAULT_LOCALE: Locale = 'en';

// Dictionary shape: flat record from dotted key to template string.
// Templates support `{name}` style placeholders interpolated by `t()`.
export type Dict = Record<string, string>;

export type TParams = Record<string, string | number>;
