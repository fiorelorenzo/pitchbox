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

// #569: image capture is its own opt-in, deliberately never folded into
// LINKEDIN_ORIGIN above (Main's call, 2026-09-09). `chrome.tabs.captureVisibleTab`
// refuses with "Either the '<all_urls>' or 'activeTab' permission is required"
// even once the scoped LinkedIn origin above is granted - measured directly
// against a real tab - and `activeTab` cannot substitute here: it only
// activates on a browser-UI gesture (the toolbar icon, a context menu, the
// commands API), never on the page-level click that triggers a capture (the
// human clicking into LinkedIn's own comment box). So the only permission
// that actually satisfies a content-script-triggered capture is `<all_urls>`,
// already declared in `manifest.config.ts`'s `optional_host_permissions` -
// this is a wider *runtime request*, not a wider static grant. Keeping it
// out of `requestLinkedInPermission` matters: the one button an operator
// presses to use the assistant at all must keep asking Chrome's narrowest
// possible question, so declining the image feature never reads as
// declining the assistant itself.
export const IMAGE_CAPTURE_ORIGIN = '<all_urls>';

/** The real current state, read from Chrome rather than assumed. */
export function hasImageCapturePermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [IMAGE_CAPTURE_ORIGIN] });
}

/**
 * Requests `<all_urls>`, for image capture only. Same user-gesture
 * constraint as `requestLinkedInPermission` - call synchronously from the
 * click, before any other `await` resolves.
 */
export function requestImageCapturePermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: [IMAGE_CAPTURE_ORIGIN] });
}

/** Revokes `<all_urls>`. Safe to call even if never granted. */
export function revokeImageCapturePermission(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [IMAGE_CAPTURE_ORIGIN] });
}
