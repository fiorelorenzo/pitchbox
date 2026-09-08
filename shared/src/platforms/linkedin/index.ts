// URL parsing for the two reachable LinkedIn project-source kinds (#436,
// spike #435's "Plane 3"). Pure parsing and mapping only, matching rule 5 of
// the compliance boundary (tests/compliance/linkedin-boundary.ts): nothing
// under shared/src/platforms/linkedin/ ever makes a network call, and never
// will - the whole point of this directory (design decision 1) is that
// LinkedIn has no server-side client in this product.
//
// These turn whatever URL a human pastes into the project page's "Add
// source" form into the exact identifier the extension's content script
// (extension/src/content/linkedin-source-capture.ts) reads directly off the
// rendered page - the activity urn for a post, the vanity slug for a
// profile - so a pending row can be matched against a real page purely by
// string equality, with no server-side fetch of the pasted URL at all
// (rule 4: no server-side automation of linkedin.com, in any form). Written
// by hand rather than imported by the extension: linkedin-observe.ts's own
// doc comment explains why the extension carries no dependency on
// @pitchbox/shared, so a change to either side's parsing needs the same
// change made to the other by hand.

const ACTIVITY_URN_RE = /urn:li:activity:(\d+)/;
// LinkedIn's own "Copy link to post" share URL:
// https://www.linkedin.com/posts/<slug>-activity-<id>-<random>/
const ACTIVITY_SHARE_RE = /-activity-(\d+)-/;
const PROFILE_PATH_RE = /\/in\/([^/?#]+)/;
const BARE_HANDLE_RE = /^[\w.-]+$/;

/**
 * A post URL or bare urn pasted for a `linkedin_post` source, normalised to
 * the exact `urn:li:activity:<id>` string
 * `extension/src/content/shared/linkedin-dom.ts`'s `readPostIdentifier`
 * reads off a real post-detail page's `data-urn` attribute. Accepts a bare
 * urn, a `/feed/update/urn:li:activity:<id>/` permalink (the urn is
 * literally in the path), or a `/posts/<slug>-activity-<id>-<random>/` share
 * URL. Returns null for anything else - a source with nothing a real page
 * can ever match is worse than refusing to create it.
 */
export function parseLinkedInPostIdentifier(input: string): string | null {
  const trimmed = input.trim();
  const direct = trimmed.match(ACTIVITY_URN_RE);
  if (direct) return `urn:li:activity:${direct[1]}`;
  const shared = trimmed.match(ACTIVITY_SHARE_RE);
  return shared ? `urn:li:activity:${shared[1]}` : null;
}

/**
 * A profile URL or bare handle pasted for a `linkedin_profile` source,
 * normalised to the vanity slug `linkedin-dom.ts`'s `readOwnProfilePageHandle`
 * parses off a real `/in/<slug>` page's own URL (its private
 * `parseProfileHandle`, duplicated here by hand for the same reason as the
 * module doc comment above). Accepts a full profile URL or a bare slug.
 */
export function parseLinkedInProfileIdentifier(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(PROFILE_PATH_RE);
  if (match) return decodeURIComponent(match[1]);
  return BARE_HANDLE_RE.test(trimmed) ? trimmed : null;
}
