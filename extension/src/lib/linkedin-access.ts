/**
 * #401: what we know about the optional LinkedIn host permission over time.
 *
 * `chrome.permissions.contains` answers "is it on right now", which is the
 * only thing the UI may claim (D22). What it cannot answer is "did Chrome
 * take it away from something that was working", and that is the state worth
 * showing in red: the assist scripts are unregistered, nothing in the page
 * happens any more, and today the operator only finds out by opening
 * Settings. The background worker already observes the transition on
 * `chrome.permissions.onRemoved` and throws it away.
 *
 * So this stores the transition, not the permission. It is written by the
 * worker (background.ts's permission listeners) and read by home.
 */
export type LinkedInAccessState = {
  /** Last time we observed the permission present. */
  grantedAt?: string;
  /**
   * Set when the permission went from present to absent, cleared the moment
   * it comes back. Unset on a fresh install: never having had it is not a
   * revocation, and must not paint home red.
   */
  revokedAt?: string;
};

const KEY = 'linkedInAccess';

export async function getLinkedInAccessState(): Promise<LinkedInAccessState> {
  const out = (await chrome.storage.local.get(KEY)) as {
    linkedInAccess?: LinkedInAccessState;
  };
  const s = out.linkedInAccess;
  if (!s || typeof s !== 'object') return {};
  return {
    grantedAt: typeof s.grantedAt === 'string' ? s.grantedAt : undefined,
    revokedAt: typeof s.revokedAt === 'string' ? s.revokedAt : undefined,
  };
}

/**
 * Records what the platform currently reports, and returns the state as
 * stored. Idempotent: called on every `onAdded`/`onRemoved` and on every
 * worker boot, so it must not invent a revocation out of a fresh install, and
 * must not keep re-stamping `revokedAt` while the permission stays off (the
 * timestamp is when it went away, not when we last noticed).
 */
export async function recordLinkedInAccess(
  present: boolean,
  now: string = new Date().toISOString(),
): Promise<LinkedInAccessState> {
  const prior = await getLinkedInAccessState();
  let next: LinkedInAccessState;
  if (present) {
    next = { grantedAt: now };
  } else if (prior.revokedAt) {
    // Already known to be off. Nothing changed, so nothing is rewritten.
    return prior;
  } else if (prior.grantedAt) {
    next = { revokedAt: now };
  } else {
    // Never seen granted: this is a fresh install, not a revocation.
    return prior;
  }
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
