import {
  getLinkedInAssistStates,
  postLinkedInReplySync,
  type IncomingLinkedInComment,
  type IncomingLinkedInMessage,
} from '../lib/api-linkedin-sync.js';
import {
  findFeedPosts,
  findMessageEvents,
  findParentCommentId,
  findPostComments,
  readCommentAuthor,
  readCommentBody,
  readCommentRelativeTime,
  readOwnProfileHandle,
  readPostIdentifier,
} from './shared/linkedin-dom.js';

// LI-10 (#307): passive reply/message ingest, the counterpart to #302's
// passive observation collector. Registered on
// https://www.linkedin.com/feed/update/*, /notifications* and /messaging*
// (see linkedin-reply-ingest-registration.ts - not wired into background.ts
// from this worktree, see the PR body). Reads only what the human's own
// navigation has already rendered and posts it to the existing
// POST /api/extension/dm-sync with platform: 'linkedin'
// (docs/linkedin-integration-design.md, "Reply detection"). No alarm, no
// fetch to linkedin.com, no navigation, no synthetic interaction - the
// compliance boundary this file must not cross.

// Debounces re-scans triggered by DOM mutations (LinkedIn's infinite-scroll
// loading more comments/messages as the human scrolls) into one pass,
// driven entirely by real page activity - never a `chrome.alarms` timer
// independent of it, which the compliance boundary forbids for LinkedIn.
const SCAN_DEBOUNCE_MS = 2000;

// Approximate durations for the relative-time vocabulary LinkedIn's English
// UI uses ("2h", "3d", "1w", ...). Not exhaustive of every unit LinkedIn
// might render (locale-dependent - see approximateTimestamp's doc comment).
const RELATIVE_UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  mo: 2_629_800_000,
  month: 2_629_800_000,
  y: 31_557_600_000,
  yr: 31_557_600_000,
  year: 31_557_600_000,
};

/**
 * Best-effort absolute timestamp from LinkedIn's own relative-time text
 * ("2h", "3 days ago", ...), falling back to the moment this content script
 * actually observed the item when the text does not parse. That fallback is
 * not a bug: the real capture this module is verified against
 * (extension/tests/content/fixtures/linkedin/post-detail.html) is from an
 * Italian-locale account ("2 giorni"), so an unparseable string is the
 * common case, not the exception, for any account not viewing LinkedIn in
 * English. `matchIncomingCommentReplies` never gates on staleness the way
 * `matchIncomingDms` does, so this approximation costs nothing functionally
 * - it only affects the "earliest reply" ordering used to pick which
 * inbound message a continuation draft replies to, which staying honestly
 * close to "when we saw it" serves as well as a fabricated precise time
 * would.
 */
function approximateTimestamp(relativeTime: string | null, observedAt: Date = new Date()): string {
  const match = relativeTime ? /^(\d+)\s*([a-z]+)/i.exec(relativeTime.trim()) : null;
  if (!match) return observedAt.toISOString();
  const amount = Number(match[1]);
  const unitMs = RELATIVE_UNIT_MS[match[2].toLowerCase()];
  if (!Number.isFinite(amount) || !unitMs) return observedAt.toISOString();
  return new Date(observedAt.getTime() - amount * unitMs).toISOString();
}

/**
 * `comment`'s parent for the dm-sync payload: the enclosing comment's own
 * URN when nested, otherwise the post's own activity URN (a top-level
 * comment's "parent" is the post itself - see
 * docs/linkedin-integration-design.md's `comment_reply` vs `post_comment`
 * draft kinds). `null` when neither resolves, which drops the comment
 * (dm-sync's own matcher would never find a draft for an unresolvable
 * parent anyway).
 */
function resolveParentId(comment: Element, post: Element | undefined): string | null {
  const nestedParent = findParentCommentId(comment, document);
  if (nestedParent) return nestedParent;
  if (!post) return null;
  const postId = readPostIdentifier(post, document);
  return postId.kind === 'urn' ? postId.value : null;
}

/**
 * Every comment/reply rendered on the current page, shaped for dm-sync.
 * Works unmodified on /notifications* too: it is driven entirely by
 * `findPostComments`'s own `detectPageKind` check, not by the URL, so it
 * naturally finds nothing on a notifications page whose markup is not the
 * classic post-detail frontend rather than needing separate, unverified
 * notifications-specific selectors (see the PR body for why this is a
 * documented gap, not a silent one).
 */
function collectComments(): IncomingLinkedInComment[] {
  const [post] = findFeedPosts(document);
  const comments: IncomingLinkedInComment[] = [];
  for (const el of findPostComments(document)) {
    const id = el.getAttribute('data-id');
    const parentId = resolveParentId(el, post);
    const author = readCommentAuthor(el, document);
    if (!id || !parentId || !author.handle) continue;
    comments.push({
      parentCommentId: parentId,
      replyCommentId: id,
      author: author.handle,
      body: readCommentBody(el, document) ?? '',
      createdAt: approximateTimestamp(readCommentRelativeTime(el, document)),
      contextUrl: location.href,
    });
  }
  return comments;
}

/**
 * Every message event rendered on the current page, shaped for dm-sync.
 * `findMessageEvents` is unverified against a live capture (see its own doc
 * comment) and only ever resolves a participant handle for a row that
 * carries a profile link - LinkedIn's own convention on a 1:1 conversation
 * is to attribute the *other* party's messages that way and not the
 * human's own, so every event this returns is conservatively treated as
 * inbound. `ownHandle` is required (not read per event): dm-sync's matcher
 * needs a `toUser` on every item, and there is exactly one signed-in member
 * per page.
 */
function collectMessages(ownHandle: string | null): IncomingLinkedInMessage[] {
  if (!ownHandle) return [];
  const items: IncomingLinkedInMessage[] = [];
  findMessageEvents(document).forEach((event, index) => {
    if (!event.participant.handle) return;
    // LinkedIn exposes no reliable per-message id anywhere this module can
    // read (see findMessageEvents's doc comment). This is stable within one
    // sync tick's dedup key (platformId, threadId) but not across a page
    // reload, so a message could in principle be re-inserted after a
    // reload if its position in the list shifted - an accepted cost of
    // passive, best-effort collection, not a silent one (documented here
    // and in the PR body).
    const threadId = `${location.pathname}:${event.participant.handle}:${index}:${event.relativeTime ?? ''}`;
    items.push({
      fromUser: event.participant.handle,
      toUser: ownHandle,
      body: event.body ?? '',
      threadId,
      createdAt: approximateTimestamp(event.relativeTime),
    });
  });
  return items;
}

let scanTimer: number | undefined;
let running = false;

async function scanAndSync(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const states = await getLinkedInAssistStates();
    // The collector half of this only runs when at least one paired
    // backend's org has the assistant on with a live bound project
    // (`collectorEnabled` already folds in both - see
    // shared/src/linkedin-assist.ts's `loadLinkedInAssistDeviceState`).
    // Reading zero DOM state and sending nothing when nobody has turned
    // this on is deliberate, not an oversight: a build whose device
    // predates the switch, or whose admin never flipped it, must not keep
    // collecting content nobody consented to.
    if (!states.some((s) => s.assist?.collectorEnabled)) return;

    const ownHandle = readOwnProfileHandle(document);
    const comments = location.pathname.startsWith('/messaging') ? [] : collectComments();
    const items = location.pathname.startsWith('/messaging') ? collectMessages(ownHandle) : [];
    if (comments.length === 0 && items.length === 0) return;

    const results = await postLinkedInReplySync(items, comments);
    // A 403 from a given backend (assist/collector off, or kill-switched -
    // #358/#359) is authoritative for that backend and not retried here;
    // the next debounced scan re-checks getLinkedInAssistStates fresh, so a
    // flipped switch takes effect on the very next tick without this
    // script needing its own retry/backoff logic.
    for (const r of results) {
      if (!r.ok) console.warn('[pitchbox] linkedin reply sync refused:', r.backendUrl, r.status);
    }
  } catch (err) {
    console.warn('[pitchbox] linkedin reply sync failed:', err);
  } finally {
    running = false;
  }
}

function scheduleScan(): void {
  if (scanTimer !== undefined) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => void scanAndSync(), SCAN_DEBOUNCE_MS);
}

scheduleScan();
new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
