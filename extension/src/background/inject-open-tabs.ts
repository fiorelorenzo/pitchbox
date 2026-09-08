import { hasLinkedInPermission } from '../lib/permissions.js';

/**
 * Runs every registered LinkedIn content script in the LinkedIn tabs that are
 * already open (#438).
 *
 * `chrome.scripting.registerContentScripts` only ever injects into a document
 * that loads *after* the registration, so a tab a human already had open when
 * they installed the extension, when it updated, or when they granted the
 * LinkedIn host permission never gets the scripts at all - and that is exactly
 * the tab a human then goes back to, on the "grant access" step the setup
 * asks for. Measured 2026-09-08 in a signed-in Chrome: nothing on the page,
 * no error anywhere, and the extension looks broken rather than un-injected.
 *
 * The script list comes from the registry rather than a second copy of every
 * match set, so this can never drift from the registrations it mirrors, and
 * `claimDocument` (extension/src/content/shared/claim-document.ts) is what
 * keeps a tab that already ran a script from running it twice.
 *
 * Best-effort by design: a tab can be a `chrome://` page, be discarded, or be
 * navigating while this runs, and every one of those throws for that tab
 * alone. Returns how many (tab, script) injections succeeded, which is what
 * the test asserts on.
 */
export async function injectIntoOpenLinkedInTabs(): Promise<number> {
  try {
    if (!(await hasLinkedInPermission())) return 0;
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const mine = registered.filter(
      (script) =>
        (script.id ?? '').startsWith('pitchbox-linkedin-') && (script.js ?? []).length > 0,
    );
    if (mine.length === 0) return 0;

    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    let injected = 0;
    for (const tab of tabs) {
      const tabId = tab.id;
      if (typeof tabId !== 'number') continue;
      for (const script of mine) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            files: script.js ?? [],
          });
          injected += 1;
        } catch (err) {
          // One tab refusing (discarded, mid-navigation, or a restricted
          // page that matched the query) must not stop the others.
          console.warn(`[pitchbox] injecting ${script.id} into tab ${tabId} failed:`, err);
        }
      }
    }
    return injected;
  } catch (err) {
    console.warn('[pitchbox] injectIntoOpenLinkedInTabs failed:', err);
    return 0;
  }
}
