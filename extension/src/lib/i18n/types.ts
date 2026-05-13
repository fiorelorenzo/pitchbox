export const LOCALES = ['en', 'it'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export type Dict = Record<string, string>;
export type TParams = Record<string, string | number>;
