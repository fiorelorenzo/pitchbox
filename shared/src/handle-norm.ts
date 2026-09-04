// Shared by dm-sync.ts and comment-sync.ts: both match a handle read from an
// inbound item (a DOM sighting or scraped payload) against a handle already
// stored on an account/contact row, and the two sides are never guaranteed
// to have been captured in the same shape.
//
// Reddit: a handle can carry a "u/" prefix ("u/alice") or not ("alice") -
// strip it so both forms key the same contact. This is the behaviour this
// module inherits unchanged from the two `norm()` functions it replaces.
//
// LinkedIn (#307): a handle is a profile vanity slug (linkedin.com/in/<slug>).
// An admin adding a LinkedIn account types whatever they see fit - the
// connect form's own placeholder ("linkedin.com/in/your-slug",
// web/src/lib/components/projects/ProjectAccountsTab.svelte) invites the
// full path - while the extension's DOM reader (linkedin-dom.ts's
// parseProfileHandle) always extracts the bare slug from an `href`. Left
// unhandled, an account saved as "linkedin.com/in/jane-doe" would never
// match a reply the content script read as "jane-doe": two
// different-looking strings for the same person, mismatching silently
// forever. Strip a leading scheme, an optional subdomain, and
// "linkedin.com/in/" down to the bare slug before the existing
// case/whitespace normalisation, so a full profile URL and a bare slug for
// the same account always normalise to the same key.
const LINKEDIN_PROFILE_URL_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^/?#]+)/i;

export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();
  const linkedinMatch = trimmed.match(LINKEDIN_PROFILE_URL_RE);
  const withoutPrefix = linkedinMatch ? linkedinMatch[1] : trimmed.replace(/^u\//i, '');
  return withoutPrefix.replace(/\/+$/, '').trim().toLowerCase();
}
