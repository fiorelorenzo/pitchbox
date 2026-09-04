// Fixture for linkedin-boundary.test.ts (#308, rule 2). Registered as a
// LinkedIn content script by the sibling background.ts's
// chrome.scripting.registerContentScripts call, not by manifest.config.ts's
// static array. Deliberately violates the compliance boundary. Inert.
export function readSession(): string {
  return document.cookie;
}
