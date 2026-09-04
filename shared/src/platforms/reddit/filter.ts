import type { ScoutCandidate } from './types.js';

/** Posts older than this are dropped as stale when maxPostAgeHours is not set (#338). */
export const DEFAULT_MAX_POST_AGE_HOURS = 72;

export interface FilterOptions {
  contactedHandles: Set<string>;
  blockedHandles: Set<string>;
  /**
   * Posts older than this are dropped as stale. Unset/null falls back to
   * DEFAULT_MAX_POST_AGE_HOURS - an absent config key still caps, it does
   * not disable the filter. An explicit 0 caps immediately (every post is
   * older than zero hours); there is no sentinel for "no cap".
   */
  maxPostAgeHours?: number | null;
  /** Injectable clock for deterministic recency tests. Defaults to now. */
  now?: Date;
}

export interface FilterResult {
  candidates: ScoutCandidate[];
  /** Count of candidates dropped for being older than maxPostAgeHours, so a run can log why. */
  droppedByAge: number;
}

function isStalePost(createdUtcSeconds: number, now: Date, maxAgeHours: number): boolean {
  const createdMs = createdUtcSeconds * 1000;
  if (!Number.isFinite(createdMs)) return true;
  return now.getTime() - createdMs > maxAgeHours * 60 * 60 * 1000;
}

/**
 * Filter out candidates that have already been contacted, are blocklisted,
 * or whose post is older than the recency cap. A reply landing on a
 * three-week-old thread is close to invisible (#338), so it is dropped here
 * at collection time rather than merely score-penalized during drafting.
 * Handle comparison is case-insensitive.
 */
export function filterCandidates(candidates: ScoutCandidate[], opts: FilterOptions): FilterResult {
  const contacted = new Set([...opts.contactedHandles].map((h) => h.toLowerCase()));
  const blocked = new Set([...opts.blockedHandles].map((h) => h.toLowerCase()));
  const maxAgeHours = opts.maxPostAgeHours ?? DEFAULT_MAX_POST_AGE_HOURS;
  const now = opts.now ?? new Date();

  let droppedByAge = 0;
  const kept = candidates.filter((c) => {
    const handle = c.user.name.toLowerCase();
    if (contacted.has(handle)) return false;
    if (blocked.has(handle)) return false;
    if (isStalePost(c.post.createdUtc, now, maxAgeHours)) {
      droppedByAge++;
      return false;
    }
    return true;
  });

  return { candidates: kept, droppedByAge };
}
