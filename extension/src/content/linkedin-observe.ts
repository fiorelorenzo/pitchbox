import { api } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import {
  findFeedPosts,
  readPostAuthor,
  readPostIdentifier,
  readPostText,
  resetSelectorHealth,
  selectorHealthActivityEvents,
} from './shared/linkedin-dom.js';

/**
 * The passive observation collector (LI-5, #302): fills `observed_targets`
 * from what the human's own scrolling already rendered on the feed, a post
 * page, or a profile's recent activity, so an async LinkedIn campaign has
 * candidates without a discovery API
 * (docs/linkedin-integration-design.md, "Observation collection").
 *
 * ## Off by default, and the server is the actual authority
 *
 * This script fetches `GET /api/extension/linkedin-assist` before touching
 * the DOM at all, and does nothing - no `MutationObserver`, no
 * `IntersectionObserver`, no timer - unless that read says both the
 * assistant and the collector are on for a bound project (LI-19, #316).
 * `POST /api/extension/observations` also enforces this server-side (#358)
 * and answers 403 (`collector_disabled` | `kill_switch` | `project_not_bound`)
 * otherwise, so this script's own gate is a courtesy that saves a request,
 * not the actual boundary - a 403 is treated as authoritative below
 * (`stopCollecting`), never retried into, and turns the collector off for
 * the rest of this script's lifetime (a full page load/navigation; there is
 * no "resume" without one).
 *
 * ## Poll cadence
 *
 * `ASSIST_POLL_MS` (60s) only runs while the collector is actually active -
 * a disabled collector makes zero requests, matching "does nothing until
 * enabled" literally, and there is nothing running that a poll would need to
 * stop. While active, 60s means an admin's kill switch is visible within a
 * minute even on a long-idle tab with nothing to flush, well inside the read
 * path's own `RateLimiter(12, 60_000)`. The hard floor underneath that is
 * `POST /api/extension/observations`'s own 403: even if this tab's poll
 * timer is throttled (backgrounded tab, MV3 considerations), the very next
 * batch attempt gets refused and stops the collector regardless of how
 * stale the last poll was - "a kill switch that only stops at the next poll
 * is not a kill switch" (docs/linkedin-integration-design.md). This script
 * deliberately does not use the alarms API for either the poll or the flush
 * timer: the compliance boundary (LI-11, #308) forbids an alarms job
 * reachable from LinkedIn code, and an in-page timer needs no such job - it
 * simply stops running once the tab closes or navigates away.
 *
 * ## Batching, not per post
 *
 * Every rendered post is queued locally (`queue`) and flushed on a
 * debounce: `FLUSH_IDLE_MS` after the last new post seen, or at
 * `FLUSH_MAX_WAIT_MS` since the oldest still-pending item, whichever comes
 * first, so continuous scrolling still flushes periodically instead of
 * debouncing forever. `MAX_BATCH_SIZE` mirrors
 * `shared/src/observed-targets.ts`'s `MAX_OBSERVED_TARGETS_BATCH` (not
 * imported - the extension has no dependency on `@pitchbox/shared`) and
 * forces an immediate flush if reached, matching the server's own cap.
 * `seenExternalIds` dedupes within this script's lifetime so a post
 * scrolled past twice is queued once.
 *
 * ## Only a post the human opened is dedupable
 *
 * `linkedin-dom.ts`'s "Two frontends, one identifier" is the reason this
 * matters: the feed's own `readPostIdentifier` returns a `render-anchor`,
 * a per-render token, never a `urn`. Only `kind: 'urn'` (the classic
 * post-detail frontend - a permalink, or one card in a recent-activity
 * list) is a stable, dedupable identifier, so only those posts are queued.
 * A feed sighting with no `urn` is read (for selector health) and then
 * dropped, not queued - `observed_targets.external_id` is `NOT NULL`, so
 * there is nothing honest to send for it, and inventing one would silently
 * violate the server's own dedup key.
 *
 * ## Viewport only
 *
 * `IntersectionObserver` gates every post: a `MutationObserver` over the
 * document notices new post elements as they render (including whatever a
 * virtual list adds while scrolling), but each one is only read once it
 * actually intersects the viewport, not the moment it lands in the DOM -
 * "read only posts that actually rendered in the viewport, not what a
 * virtual list is holding offscreen" (design doc, "Observation collection").
 */

// Matches shared/src/observed-targets.ts's MAX_OBSERVED_TARGETS_BATCH.
const MAX_BATCH_SIZE = 200;

const ASSIST_POLL_MS = 60_000;
const FLUSH_IDLE_MS = 3_000;
const FLUSH_MAX_WAIT_MS = 15_000;

type QueuedObservation = {
  externalId: string;
  url: string;
  authorHandle: string | null;
  authorName: string | null;
  text: string | null;
  observedAt: string;
};

let collectorEnabled = false;
let boundProjectId: number | null = null;
// Once true, this script instance never collects again - see the module
// doc comment's "off by default" section.
let stopped = false;

const seenExternalIds = new Set<string>();
const observedElements = new WeakSet<Element>();
let pending: QueuedObservation[] = [];
let idleTimer: number | undefined;
let maxWaitTimer: number | undefined;
let assistPollTimer: number | undefined;
let mutationObserver: MutationObserver | undefined;
let intersectionObserver: IntersectionObserver | undefined;

function reportSelectorHealth(): void {
  for (const event of selectorHealthActivityEvents()) logFromContent(event);
}

function clearFlushTimers(): void {
  if (idleTimer !== undefined) {
    window.clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (maxWaitTimer !== undefined) {
    window.clearTimeout(maxWaitTimer);
    maxWaitTimer = undefined;
  }
}

function stopCollecting(reason: string): void {
  if (stopped) return;
  stopped = true;
  mutationObserver?.disconnect();
  intersectionObserver?.disconnect();
  if (assistPollTimer !== undefined) {
    window.clearInterval(assistPollTimer);
    assistPollTimer = undefined;
  }
  clearFlushTimers();
  pending = [];
  logFromContent({
    level: 'warn',
    source: 'linkedin-collector',
    message: 'activity.linkedin-collector.stopped',
    messageParams: { reason },
    meta: { reason, url: location.href },
  });
}

function scheduleFlush(): void {
  if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => void flush(), FLUSH_IDLE_MS);
  if (maxWaitTimer === undefined) {
    maxWaitTimer = window.setTimeout(() => void flush(), FLUSH_MAX_WAIT_MS);
  }
}

async function flush(): Promise<void> {
  clearFlushTimers();
  if (stopped || pending.length === 0 || boundProjectId === null) return;
  const items = pending;
  pending = [];
  const res = await api.observeLinkedIn(boundProjectId, items);
  if (res.ok) {
    logFromContent({
      level: 'info',
      source: 'linkedin-collector',
      message: 'activity.linkedin-collector.batch-sent',
      messageParams: {
        inserted: res.data.inserted,
        duplicates: res.data.duplicates,
        dropped: res.data.dropped,
      },
    });
    return;
  }
  if (res.status === 403) {
    let reason = 'refused';
    try {
      const parsed = JSON.parse(res.error) as { message?: string };
      if (parsed.message) reason = parsed.message;
    } catch {
      // Non-JSON body: keep the generic reason above.
    }
    stopCollecting(reason);
    return;
  }
  // Transient failure (network error, 429, 5xx): put the batch back for the
  // next flush rather than losing it silently. Bounded by MAX_BATCH_SIZE so
  // a long outage can't grow this without limit while the human keeps
  // scrolling.
  pending = [...items, ...pending].slice(0, MAX_BATCH_SIZE);
  logFromContent({
    level: 'warn',
    source: 'linkedin-collector',
    message: 'activity.linkedin-collector.batch-failed',
    messageParams: { reason: res.error || String(res.status) },
  });
}

function queue(observation: QueuedObservation): void {
  if (stopped) return;
  if (seenExternalIds.has(observation.externalId)) return;
  seenExternalIds.add(observation.externalId);
  pending.push(observation);
  if (pending.length >= MAX_BATCH_SIZE) {
    void flush();
    return;
  }
  scheduleFlush();
}

function processPost(post: Element): void {
  if (stopped) return;
  const identifier = readPostIdentifier(post);
  const author = readPostAuthor(post);
  const text = readPostText(post);
  if (identifier.kind !== 'urn') {
    // Feed sighting: read for selector health, not dedupable, not queued -
    // see the module doc comment's "Only a post the human opened" section.
    return;
  }
  queue({
    externalId: identifier.value,
    url: location.href,
    authorHandle: author.handle,
    authorName: author.name,
    text,
    observedAt: new Date().toISOString(),
  });
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  if (stopped) return;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    intersectionObserver?.unobserve(entry.target);
    processPost(entry.target);
  }
  reportSelectorHealth();
}

function scanForNewPosts(): void {
  if (stopped || !intersectionObserver) return;
  for (const post of findFeedPosts()) {
    if (observedElements.has(post)) continue;
    observedElements.add(post);
    intersectionObserver.observe(post);
  }
}

function startObserving(): void {
  if (mutationObserver) return; // already running
  intersectionObserver = new IntersectionObserver(onIntersect, { threshold: 0.25 });
  mutationObserver = new MutationObserver(() => scanForNewPosts());
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  scanForNewPosts();
}

async function pollAssistState(): Promise<void> {
  if (stopped) return;
  const res = await api.linkedinAssist();
  // A transient read failure keeps whatever state this script already has -
  // a real, current refusal still surfaces authoritatively on the next
  // POST /api/extension/observations (see the module doc comment).
  if (!res.ok) return;
  const { assist } = res.data;
  const wasEnabled = collectorEnabled;
  collectorEnabled = assist.collectorEnabled;
  boundProjectId = assist.projectId;
  if (!collectorEnabled) {
    if (wasEnabled) stopCollecting(assist.killSwitch ? 'kill_switch' : 'collector_disabled');
    return;
  }
  if (!wasEnabled) startObserving();
}

async function init(): Promise<void> {
  resetSelectorHealth();
  await pollAssistState();
  if (collectorEnabled && !stopped) {
    assistPollTimer = window.setInterval(() => void pollAssistState(), ASSIST_POLL_MS);
  }
}

void init();
