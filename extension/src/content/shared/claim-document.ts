/**
 * One-run-per-document guard for a LinkedIn content script (#438).
 *
 * Two injection paths now reach the same page. A registered content script
 * runs when a document loads at a matching URL, and
 * `injectIntoOpenLinkedInTabs` runs the same file with
 * `chrome.scripting.executeScript` in tabs that were already open when the
 * extension was installed, updated, or granted the LinkedIn host - the tabs
 * a registration can never reach, and the ones a human has open when they
 * install the thing. Both land in the extension's own isolated world, which
 * is one realm per (extension, frame), so a flag on `globalThis` there is
 * visible to both and to neither the page nor another extension.
 *
 * Without this, a script injected into a tab that already had it would
 * attach a second `MutationObserver` and a second click listener per
 * composer. The panel host's own dedupe (D11) would keep one panel on
 * screen, so the symptom would not be a visible double panel: it would be
 * two suggestion requests billed for one click.
 *
 * Returns true exactly once per document, for the caller that should run.
 */
export function claimDocument(id: string): boolean {
  const realm = globalThis as unknown as Record<string, unknown>;
  const key = `__pitchbox_claimed_${id}`;
  if (realm[key] === true) return false;
  realm[key] = true;
  return true;
}

/**
 * Test seam: forgets every claim in this realm.
 *
 * The flag deliberately outlives a module instance - that is the whole point
 * in production, where a second injection is a second instance of the same
 * script in one realm. A test that re-imports a content script with
 * `vi.resetModules()` gets exactly that shape without meaning to, so it has
 * to say so, and calling this in its `beforeEach` is how (mirrors
 * `resetPanelStylesForTests` in panel-host.ts).
 */
export function releaseDocumentClaimsForTests(): void {
  const realm = globalThis as unknown as Record<string, unknown>;
  for (const key of Object.keys(realm)) {
    if (key.startsWith('__pitchbox_claimed_')) Reflect.deleteProperty(realm, key);
  }
}
