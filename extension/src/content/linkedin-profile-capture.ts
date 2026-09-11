import { claimDocument } from './shared/claim-document.js';
import {
  readOwnProfile,
  readOwnPosts,
  readOwnComments,
  readOwnProfilePageHandle,
  resetSelectorHealth,
  selectorHealthActivityEvents,
  type OwnPost,
  type OwnComment,
  type OwnProfileCapture,
} from './shared/linkedin-dom.js';
import { logFromContent } from '../lib/log-from-content.js';
import { getSettings, type Pairing } from '../lib/storage.js';

/**
 * The operator persona capture (LI-21, 2026-09-07): reads the signed-in
 * member's own `/in/<slug>` page - and its `recent-activity` siblings, the
 * default posts tab and, since LOR-228, its `/comments` tab - and posts
 * what it found to `POST /api/extension/operator-profile`, once per page
 * view per pairing, so the in-page companion can write as this person
 * (docs/linkedin-integration-design.md, "Epic B"). Registered on
 * `https://www.linkedin.com/in/*` (linkedin-profile-capture-registration.ts),
 * which covers all three pages with one match pattern.
 *
 * ## Passive only, and the server is the actual authority
 *
 * This reads only what the human's own navigation already rendered - no
 * fetch, no navigation, no synthetic interaction, matching every other
 * content script in this directory (the compliance boundary,
 * docs/linkedin-integration-design.md). It cannot tell, from the DOM alone,
 * whether the `/in/<slug>` page open right now is the operator's own or a
 * page they opened to read someone else's - `readOwnProfile`'s own doc
 * comment explains why it does not try. The one thing this script does
 * different from `linkedin-observe.ts`'s collector is that its safety net
 * lives entirely server-side: `POST /api/extension/operator-profile`
 * refuses a capture whose `handle` does not match the operator already on
 * file (`refused: 'not_your_profile'`), and separately refuses a
 * `displayName` that is not name-shaped (`refused: 'implausible_name'`,
 * LOR-180 - this script's own selector scoping in `linkedin-dom.ts` is a
 * defense the server cannot see past), rather than this script guessing.
 *
 * ## One post per page view, per pairing
 *
 * `lastSentByBackend` remembers the exact JSON this script already sent to
 * each paired backend and skips sending it again - a `MutationObserver`
 * re-triggers `scan` as the top card or the recent-activity list finishes
 * rendering (LinkedIn's own client-side navigation and infinite scroll both
 * mutate the DOM well after `document_idle`), and most of those re-scans
 * produce the exact same payload this script already sent. Debounced the
 * same way `linkedin-reply-ingest.ts` debounces its own re-scans, for the
 * same reason: a burst of mutations should cost one request, not one per
 * mutation.
 */

const SCAN_DEBOUNCE_MS = 2000;

// Named apart from the fetch call below on purpose, matching
// api-linkedin-sync.ts's own DEVICE_ASSIST_STATE_PATH: tests/compliance/
// linkedin-boundary.ts rule 1 flags any fetch() whose target argument text
// mentions "linkedin", which would otherwise false-positive here even
// though this request is bound for our own backend (`p.backendUrl`), not
// linkedin.com.
const OPERATOR_PROFILE_PATH = '/api/extension/operator-profile';

type CapturePayload = {
  handle: string;
  displayName?: string;
  headline?: string;
  about?: string;
  experiences?: OwnProfileCapture['experiences'];
  posts?: OwnPost[];
  comments?: OwnComment[];
};

type CaptureResponse =
  { ok: true; refused?: undefined; voiceSamplesRecorded: number } | { ok: false; refused: string };

/**
 * Reads whatever the currently rendered page offers: the profile card (name,
 * headline, about, experience) when a top card is present, any posts
 * `readOwnPosts` finds (only present on the `recent-activity` page), and any
 * comments `readOwnComments` finds (only present on its `/comments` tab,
 * LOR-228). Returns `null` when there is no handle at all - the one field
 * every capture must carry, since it is what the server's persona guard
 * keys on.
 */
function collect(): CapturePayload | null {
  const profile = readOwnProfile(document);
  const posts = readOwnPosts(document);
  const comments = readOwnComments(document);
  const handle = profile?.handle ?? readOwnProfilePageHandle(document);
  if (!handle) return null;

  const payload: CapturePayload = { handle };
  if (profile?.displayName) payload.displayName = profile.displayName;
  if (profile?.headline) payload.headline = profile.headline;
  if (profile?.about) payload.about = profile.about;
  if (profile && profile.experiences.length > 0) payload.experiences = profile.experiences;
  if (posts.length > 0) payload.posts = posts;
  if (comments.length > 0) payload.comments = comments;

  // A handle with nothing else attached is what a topcard selector miss
  // looks like from here - readOwnProfile returns null the moment its own
  // name selector misses (see its doc comment), so `profile` is null and
  // every optional field above stays unset. Posting that anyway would
  // carry nothing the server could act on, and next to an earlier, real
  // capture in the activity log it would read as "the persona is now
  // nothing" rather than "the card had not rendered yet". Skip it; the
  // next debounced rescan gets another chance once it has.
  const hasContent =
    payload.displayName !== undefined ||
    payload.headline !== undefined ||
    payload.about !== undefined ||
    payload.experiences !== undefined ||
    payload.posts !== undefined ||
    payload.comments !== undefined;
  if (!hasContent) return null;

  return payload;
}

function reportSelectorHealth(): void {
  for (const event of selectorHealthActivityEvents()) logFromContent(event);
}

const lastSentByBackend = new Map<string, string>();

async function postToPairing(pairing: Pairing, serialized: string): Promise<void> {
  const res = await fetch(`${pairing.backendUrl}${OPERATOR_PROFILE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pairing.token}` },
    body: serialized,
  });
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as CaptureResponse;
  lastSentByBackend.set(pairing.backendUrl, serialized);
  if (!body.ok) {
    logFromContent({
      level: 'info',
      source: 'linkedin-collector',
      message: 'activity.linkedin-collector.profile-refused',
      messageParams: { reason: body.refused },
    });
    return;
  }
  logFromContent({
    level: 'info',
    source: 'linkedin-collector',
    message: 'activity.linkedin-collector.profile-captured',
    messageParams: {},
  });
  if (body.voiceSamplesRecorded > 0) {
    logFromContent({
      level: 'info',
      source: 'linkedin-collector',
      message: 'activity.linkedin-collector.voice-samples-captured',
      messageParams: { count: body.voiceSamplesRecorded },
    });
  }
}

async function scan(): Promise<void> {
  reportSelectorHealth();
  const payload = collect();
  if (!payload) return;
  const serialized = JSON.stringify(payload);

  const { pairings } = await getSettings();
  const targets = pairings.filter((p) => lastSentByBackend.get(p.backendUrl) !== serialized);
  if (targets.length === 0) return;

  const settled = await Promise.allSettled(targets.map((p) => postToPairing(p, serialized)));
  for (const result of settled) {
    if (result.status === 'rejected') {
      logFromContent({
        level: 'warn',
        source: 'linkedin-collector',
        message: 'activity.linkedin-collector.profile-failed',
        messageParams: {
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
      });
    }
  }
}

let scanTimer: number | undefined;

function scheduleScan(): void {
  if (scanTimer !== undefined) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => void scan(), SCAN_DEBOUNCE_MS);
}

if (claimDocument('linkedin-profile-capture')) {
  resetSelectorHealth();
  scheduleScan();
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
}
