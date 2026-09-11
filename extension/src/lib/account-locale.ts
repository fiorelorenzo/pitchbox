/**
 * Applies the account's server-resolved language override (LOR-262) to this
 * install's local cache. One function, called from every context that
 * already polls `GET /api/extension/linkedin-assist` (the passive
 * collector, both in-page assist panels, the side panel's plan poll) -
 * `linkedin-assist`'s own doc comment is the "put it where the extension is
 * already polling" call site this backs.
 *
 * A `null`/unrecognised value means the paired device has no account to
 * read a preference from (self-host, or a device paired by redeeming a
 * one-time code rather than through session-carrying auto-pair - see
 * `web/src/lib/server/extension-auth.ts`'s `ExtensionAuthContext.userId`
 * doc comment) - this is a no-op, leaving `chrome.storage` exactly as it
 * is, since local storage is already the floor
 * (`resolveInitialLocale`'s `chrome.i18n.getUILanguage()` fallback) and a
 * device with no account must not lose its language.
 */
import { LOCALES, setLocale, type Locale } from './i18n/index.js';
import { getSettings, setSettings } from './settings.js';

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

export async function applyAccountLocale(next: string | null | undefined): Promise<void> {
  if (!isLocale(next)) return;
  const current = await getSettings();
  if (current.locale === next) return;
  await setSettings({ locale: next });
  // Live-updates the calling context's own rendered `$t` text too, when it
  // shares this module's `locale` store instance (the side panel, and each
  // in-page panel content script) - a bonus over "next handshake", not a
  // requirement of it.
  setLocale(next);
}
