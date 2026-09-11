/**
 * The dashboard message catalogue's own type shapes (LOR-263), split out the
 * same way `extension/src/lib/i18n/types.ts` and `shared/src/messages/types.ts`
 * are: `Locale` itself is not redeclared here, it is `web/src/lib/i18n.ts`'s
 * (LOR-260's locale-resolution seam) - this catalogue is a second module next
 * to it, not a replacement for it.
 */
import type { Locale } from '../i18n.js';

export type { Locale };

/** One locale's full flat key -> template map. */
export type Dict = Record<string, string>;

/** Named values substituted into a template's `{name}` placeholders. */
export type TParams = Record<string, string | number>;
