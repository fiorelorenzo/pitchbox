import { claimDocument } from './shared/claim-document.js';
import { api, type ProjectSourcePostOutput, type ProjectSourceProfileOutput } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import {
  detectPageKind,
  findFeedPosts,
  readOwnProfile,
  readOwnProfilePageHandle,
  readPostAuthor,
  readPostIdentifier,
  readPostText,
  resetSelectorHealth,
  selectorHealthActivityEvents,
} from './shared/linkedin-dom.js';

/**
 * Fills a pending `linkedin_post`/`linkedin_profile` project source (#436,
 * spike #435's "Plane 3"): the dashboard creates a pending row with nothing
 * but a URL (`output: null`, `fetchedAt: null`); this script is what
 * actually fills it, by reading whatever the human's own navigation already
 * rendered and posting the result to our own backend - the same shape
 * `linkedin-observe.ts` already uses to fill `observed_targets`, never a
 * fetch, a click or a synthetic submit on linkedin.com itself.
 * `linkedin_company` is not implemented here: no page-kind branch below
 * ever asks about one, so a pending `linkedin_company` row (not that the
 * dashboard can even create one - see `ADDABLE_KINDS` in
 * `web/src/routes/api/projects/[id]/sources/+server.ts`) simply stays
 * pending forever until that selector work lands.
 *
 * Two steps per page view, mediated entirely through `lib/api.ts`'s single-
 * pairing helpers, matching `linkedin-observe.ts`'s own shape rather than a
 * second one: a small GET first asks whether the page's identifier matches
 * ANY pending source in this org at all, before anything is read from the
 * DOM; only a real match triggers the second call, POSTing what the page
 * actually showed. A page with nothing pending never has its content sent
 * anywhere. Debounced by a `MutationObserver` on `document.body`, the same
 * pattern `linkedin-profile-capture.ts` uses, since LinkedIn's own
 * client-side navigation and the post/profile card itself both render well
 * after `document_idle`.
 *
 * No new selector work: the identifier and the output both come from
 * accessors plane 1 and LI-21 already shipped and proved -
 * `readPostIdentifier`/`readPostAuthor`/`readPostText` for a post,
 * `readOwnProfilePageHandle`/`readOwnProfile` for a profile (the spike
 * showed `readOwnProfile` generalises to a third party's page with zero
 * changes - the "own" in the name was only ever a persona-capture policy
 * choice enforced server-side, not a selector constraint).
 */

const SCAN_DEBOUNCE_MS = 2000;

type PageMatch =
  { kind: 'linkedin_post'; identifier: string } | { kind: 'linkedin_profile'; identifier: string };

/** What page is open right now, if it is one of the two reachable kinds.
 * Checked in this order because a profile URL's own page kind is
 * `'unknown'` (linkedin-dom.ts's own doc comment on `detectPageKind`), so a
 * post-detail check first and a pathname-based profile check second never
 * collide. */
function currentPageMatch(): PageMatch | null {
  if (detectPageKind(document) === 'post-detail-classic') {
    const post = findFeedPosts(document)[0];
    if (!post) return null;
    const id = readPostIdentifier(post, document);
    return id.kind === 'urn' ? { kind: 'linkedin_post', identifier: id.value } : null;
  }
  const handle = readOwnProfilePageHandle(document);
  return handle ? { kind: 'linkedin_profile', identifier: handle } : null;
}

/** The kind-specific capture, once a match is confirmed. Returns null while
 * the real content (post text, profile name) has not rendered yet - the
 * caller retries on the next debounced tick rather than posting a payload
 * with nothing in it. */
function collectOutput(
  match: PageMatch,
): ProjectSourcePostOutput | ProjectSourceProfileOutput | null {
  if (match.kind === 'linkedin_post') {
    const post = findFeedPosts(document)[0];
    if (!post) return null;
    const text = readPostText(post, document);
    if (!text) return null;
    const author = readPostAuthor(post, document);
    return {
      urn: match.identifier,
      authorName: author.name,
      authorHandle: author.handle,
      text,
      url: location.href,
      capturedAt: new Date().toISOString(),
    };
  }
  const profile = readOwnProfile(document);
  if (!profile?.displayName) return null;
  return {
    handle: match.identifier,
    displayName: profile.displayName,
    headline: profile.headline,
    about: profile.about,
    experiences: profile.experiences.length > 0 ? profile.experiences : undefined,
    url: location.href,
    capturedAt: new Date().toISOString(),
  };
}

function reportSelectorHealth(): void {
  for (const event of selectorHealthActivityEvents()) logFromContent(event);
}

// Per page view: `key` (`kind:identifier`) -> whether a match has been
// asked for yet, what it resolved to, and whether it has already been
// filled. A miss or a fill is terminal for this page view; a match still
// waiting on the DOM is retried on the next debounced tick without asking
// the server again.
type MatchState = { sourceId: number } | 'no-match' | 'filled';
const stateByKey = new Map<string, MatchState>();

async function scan(): Promise<void> {
  reportSelectorHealth();
  const match = currentPageMatch();
  if (!match) return;
  const key = `${match.kind}:${match.identifier}`;

  let state = stateByKey.get(key);
  if (state === undefined) {
    const res = await api.matchProjectSource(match.kind, match.identifier);
    if (!res.ok) return; // transient - ask again on the next debounced tick
    state = res.data.match ? { sourceId: res.data.match.sourceId } : 'no-match';
    stateByKey.set(key, state);
  }
  if (state === 'no-match' || state === 'filled') return;

  const output = collectOutput(match);
  if (!output) return; // matched, but the real content hasn't rendered yet

  const fillRes = await api.fillProjectSource(state.sourceId, match.kind, match.identifier, output);
  if (!fillRes.ok) {
    logFromContent({
      level: 'warn',
      source: 'linkedin-collector',
      message: 'activity.linkedin-collector.source-fill-failed',
      messageParams: { reason: fillRes.error || String(fillRes.status) },
    });
    return; // retry on the next debounced tick
  }
  if (!fillRes.data.ok) return; // stale match (row deleted/refilled elsewhere) - nothing more to do
  stateByKey.set(key, 'filled');
  logFromContent({
    level: 'info',
    source: 'linkedin-collector',
    message: 'activity.linkedin-collector.source-filled',
    messageParams: { kind: match.kind },
  });
}

let scanTimer: number | undefined;

function scheduleScan(): void {
  if (scanTimer !== undefined) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => void scan(), SCAN_DEBOUNCE_MS);
}

if (claimDocument('linkedin-source-capture')) {
  resetSelectorHealth();
  scheduleScan();
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
}
