import { getDb, schema } from '@pitchbox/shared/db';
import { and, eq } from 'drizzle-orm';
import { computeBackoff } from '@pitchbox/shared/scheduler/backoff';
import { notify } from '@pitchbox/shared/notifications';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger('keyword-watcher');

/**
 * Consecutive fetch-failure count at which a watch backs off and raises a
 * `keyword_watch.failing` notification. Lower than the campaign circuit
 * breaker's `FAILURE_PAUSE_THRESHOLD` (10): fetches happen far more often
 * (every ~5 min per active watch, against a rate-limit-prone unauthenticated
 * Reddit endpoint), so we want backoff to kick in sooner.
 */
export const WATCH_FAILURE_THRESHOLD = 3;

export interface WatchFailureDecision {
  consecutiveFailures: number;
  nextAttemptAfter: Date | null;
  shouldNotify: boolean;
}

/**
 * Pure decision for one failed fetch: bump the consecutive-failure counter
 * and, once it reaches `WATCH_FAILURE_THRESHOLD`, space out further attempts
 * with the same exponential backoff the scheduler uses for campaigns.
 * `shouldNotify` is true only on the tick that crosses the threshold, so a
 * watch that stays broken doesn't spam a notification on every subsequent
 * failed attempt.
 */
export function evaluateWatchFailure(
  previousFailures: number,
  now: Date,
  opts: { threshold?: number } = {},
): WatchFailureDecision {
  const threshold = opts.threshold ?? WATCH_FAILURE_THRESHOLD;
  const safePrevious =
    Number.isFinite(previousFailures) && previousFailures > 0 ? previousFailures : 0;
  const consecutiveFailures = safePrevious + 1;
  const backedOff = consecutiveFailures >= threshold;
  const nextAttemptAfter = backedOff
    ? new Date(now.getTime() + computeBackoff(consecutiveFailures - threshold + 1))
    : null;
  return {
    consecutiveFailures,
    nextAttemptAfter,
    shouldNotify: consecutiveFailures === threshold,
  };
}

type RedditPostChild = {
  data: {
    id: string;
    name: string;
    title?: string;
    selftext?: string;
    body?: string;
    created_utc: number;
    permalink?: string;
  };
};

type RedditListing = { data: { children: RedditPostChild[] } };

/**
 * Compile a watch `pattern` into a tester. If the pattern is bracketed by `/.../`
 * it's treated as a JS regex (case-insensitive); otherwise as a case-insensitive
 * substring match. A bad regex falls back to substring matching so a typo can't
 * poison the worker.
 */
export function compilePattern(pattern: string): (text: string) => boolean {
  const trimmed = pattern.trim();
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const last = trimmed.lastIndexOf('/');
    const body = trimmed.slice(1, last);
    const flags = trimmed.slice(last + 1) || 'i';
    try {
      const re = new RegExp(body, flags.includes('i') ? flags : flags + 'i');
      return (s: string) => re.test(s);
    } catch {
      // Fall through to substring matching on invalid regex.
    }
  }
  const needle = trimmed.toLowerCase();
  return (s: string) => s.toLowerCase().includes(needle);
}

async function fetchListing(subreddit: string): Promise<RedditPostChild[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=25`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'pitchbox-keyword-watcher/0.3 (+https://github.com/pitchbox)' },
  });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const body = (await res.json()) as RedditListing;
  return body.data?.children ?? [];
}

async function triggerRun(
  campaignId: number,
  match: { postId: string; title: string },
): Promise<boolean> {
  const url = `${config.webUrl}/api/run`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId, trigger: 'keyword', match }),
    });
    return res.ok || res.status === 409;
  } catch (err) {
    log.warn(`trigger failed: ${String(err)}`);
    return false;
  }
}

/**
 * One watcher tick: for each active watch, fetch r/{subreddit}/new.json and
 * dispatch the campaign when the pattern matches a post not seen yet and the
 * cooldown has elapsed. `lastSeenAt` is bumped to `now` on a successful match.
 */
export async function tick(
  fetchListingImpl: (sub: string) => Promise<RedditPostChild[]> = fetchListing,
  triggerRunImpl: (
    campaignId: number,
    match: { postId: string; title: string },
  ) => Promise<boolean> = triggerRun,
): Promise<{ checked: number; dispatched: number }> {
  const db = getDb();
  const now = new Date();

  const watches = await db
    .select()
    .from(schema.keywordWatches)
    .where(eq(schema.keywordWatches.isActive, true));

  let dispatched = 0;
  for (const w of watches) {
    // Cooldown gate: skip when last hit is within the configured window.
    if (w.lastSeenAt) {
      const elapsedMs = now.getTime() - w.lastSeenAt.getTime();
      if (elapsedMs < w.cooldownMinutes * 60_000) continue;
    }

    // Backoff gate: skip while still spaced out after consecutive fetch failures.
    if (w.nextAttemptAfter && now < w.nextAttemptAfter) continue;

    let children: RedditPostChild[];
    try {
      children = await fetchListingImpl(w.subreddit);
    } catch (err) {
      log.warn(`fetch failed for r/${w.subreddit}: ${String(err)}`);
      const decision = evaluateWatchFailure(w.consecutiveFailures, now);
      await db
        .update(schema.keywordWatches)
        .set({
          consecutiveFailures: decision.consecutiveFailures,
          nextAttemptAfter: decision.nextAttemptAfter,
        })
        .where(eq(schema.keywordWatches.id, w.id));
      if (decision.shouldNotify) {
        log.warn(
          `backing off watch #${w.id} (r/${w.subreddit}) after ${decision.consecutiveFailures} consecutive fetch failures`,
        );
        await notify(db, {
          kind: 'keyword_watch.failing',
          title: `Keyword watch on r/${w.subreddit} is failing`,
          body: `Pitchbox failed to fetch r/${w.subreddit}/new.json ${decision.consecutiveFailures} times in a row. Last error: ${String(err)}`,
          payload: {
            watchId: w.id,
            campaignId: w.campaignId,
            subreddit: w.subreddit,
            consecutiveFailures: decision.consecutiveFailures,
          },
          severity: 'warning',
        });
      }
      continue;
    }

    if (w.consecutiveFailures > 0 || w.nextAttemptAfter) {
      // Fetch recovered - clear the failure/backoff state.
      await db
        .update(schema.keywordWatches)
        .set({ consecutiveFailures: 0, nextAttemptAfter: null })
        .where(eq(schema.keywordWatches.id, w.id));
    }

    const test = compilePattern(w.pattern);
    const seenCutoff = w.lastSeenAt ? Math.floor(w.lastSeenAt.getTime() / 1000) : 0;

    let hit: RedditPostChild | null = null;
    for (const child of children) {
      const d = child.data;
      if (d.created_utc <= seenCutoff) continue;
      const field =
        w.matchField === 'title'
          ? (d.title ?? '')
          : w.matchField === 'selftext'
            ? (d.selftext ?? '')
            : (d.body ?? d.selftext ?? '');
      if (test(field)) {
        hit = child;
        break;
      }
    }

    if (!hit) continue;

    const ok = await triggerRunImpl(w.campaignId, {
      postId: hit.data.name ?? hit.data.id,
      title: hit.data.title ?? '',
    });
    if (ok) {
      dispatched++;
      await db
        .update(schema.keywordWatches)
        .set({ lastSeenAt: now })
        .where(and(eq(schema.keywordWatches.id, w.id)));
      log.info(
        `dispatched campaign #${w.campaignId} from watch #${w.id} (r/${w.subreddit}, post=${hit.data.id})`,
      );
    }
  }

  return { checked: watches.length, dispatched };
}
