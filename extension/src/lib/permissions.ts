import type { Pairing } from './storage';

/**
 * Whether any pairing in `pairings` still targets the same origin as
 * `origin`. Used before revoking a chrome.permissions host grant on
 * disconnect: pairing to a backend requests an optional host permission for
 * its origin (see ConnectionCard's pair()/connectWithCode()), and since two
 * pairings can share an origin (e.g. re-pairing the same backend with a new
 * token), disconnecting one must not revoke access another still needs.
 */
export function originStillNeeded(pairings: Pairing[], origin: string): boolean {
  return pairings.some((p) => {
    try {
      return new URL(p.backendUrl).origin === origin;
    } catch {
      return false;
    }
  });
}

// #317: the LinkedIn host permission is optional (see
// `manifest.config.ts`'s `optional_host_permissions: ['<all_urls>']`) and
// must be requested on demand, from a user gesture, rather than declared in
// `host_permissions` - a blanket grant at install time is both alarming and
// a Chrome Web Store review risk. `*://*.linkedin.com/*` matches
// `docs/linkedin-integration-design.md` decision 7.
export const LINKEDIN_ORIGIN = '*://*.linkedin.com/*';

/** The real current state, read from Chrome rather than assumed. */
export function hasLinkedInPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [LINKEDIN_ORIGIN] });
}

/**
 * Requests the LinkedIn origin. Must be called synchronously from a user
 * gesture (before any other `await` resolves) - Chrome rejects
 * `chrome.permissions.request` outside one. Resolves `false` on an explicit
 * user decline, distinct from a caller catching a thrown request failure.
 */
export function requestLinkedInPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: [LINKEDIN_ORIGIN] });
}

/** Revokes the LinkedIn origin. Safe to call even if never granted. */
export function revokeLinkedInPermission(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [LINKEDIN_ORIGIN] });
}
