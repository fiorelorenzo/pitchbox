/**
 * Resolves the operator's locale preference for the in-page LinkedIn panel
 * (LOR-261), through the background worker rather than a direct
 * `chrome.storage` read here.
 *
 * The side panel calls `resolveInitialLocale()` (`lib/i18n/index.js`)
 * directly and it has always worked, because nothing about
 * `chrome.storage.local.get` is actually off-limits to a content script -
 * `tests/compliance/linkedin-boundary.ts`'s rule 2 only scans a LinkedIn
 * content script's own source for `document.cookie`, `chrome.cookies`,
 * `localStorage`/`sessionStorage`; `chrome.storage` never appears in its
 * pattern list. So this round trip is not compliance-driven - it is the same
 * design `media-capture.ts`'s `worthAsking()` moved to after the
 * `chrome.permissions` defect (2026-09-10): a content script gets a
 * narrower, less predictable API surface than the extension's other
 * contexts, a rejection here has no visible error path (D18's "panel stuck
 * on 'Reading the post...' forever" failure mode), and the worker is already
 * the single owner of `extensionSettings` reads for every other write path
 * (`background.ts`'s `applyAlarms`/`syncLinkedInContentScripts`). One more
 * reader drifting from that owner is exactly the class of bug
 * `AGENTS.md`'s "one owner reads, children take props" note was written
 * about.
 *
 * Never throws, and never leaves the panel waiting on it: any failure -
 * `chrome.runtime` unavailable, the worker unreachable, an unexpected
 * response shape - resolves to `DEFAULT_LOCALE` rather than rejecting.
 */
import { DEFAULT_LOCALE, type Locale } from '../../lib/i18n/index.js';

export type ResolveLocaleMessage = { type: 'pitchbox:resolve-locale' };
export type ResolveLocaleResponse = { ok: true; locale: Locale } | { ok: false };

export async function resolvePanelLocale(): Promise<Locale> {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    return DEFAULT_LOCALE;
  }
  try {
    const response = await new Promise<ResolveLocaleResponse>((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'pitchbox:resolve-locale' } satisfies ResolveLocaleMessage,
          (res: ResolveLocaleResponse | undefined) => {
            resolve(chrome.runtime.lastError || !res ? { ok: false } : res);
          },
        );
      } catch {
        resolve({ ok: false });
      }
    });
    return response.ok ? response.locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}
