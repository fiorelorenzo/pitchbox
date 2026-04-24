import type { ScoutCandidate } from './types.js';

export interface FilterOptions {
  contactedHandles: Set<string>;
  blockedHandles: Set<string>;
}

/**
 * Filter out candidates that have already been contacted or are blocklisted.
 * Comparison is case-insensitive.
 */
export function filterCandidates(
  candidates: ScoutCandidate[],
  opts: FilterOptions,
): ScoutCandidate[] {
  const contacted = new Set([...opts.contactedHandles].map((h) => h.toLowerCase()));
  const blocked = new Set([...opts.blockedHandles].map((h) => h.toLowerCase()));

  return candidates.filter((c) => {
    const handle = c.user.name.toLowerCase();
    if (contacted.has(handle)) return false;
    if (blocked.has(handle)) return false;
    return true;
  });
}
