import type { Pairing } from './storage';

/**
 * Whether any pairing in `pairings` still targets the same origin as
 * `origin`. Used before revoking a chrome.permissions host grant on
 * disconnect: pairing to a backend requests an optional host permission for
 * its origin (see ConnectionCard's pair()/connectWithCode()), and since two
 * pairings can share an origin (e.g. re-pairing the same backend with a new
 * token), disconnecting one must not revoke access another still needs.
 */
export function originStillNeeded(pairings: Pairing[], origin: string): boolean {
  return pairings.some((p) => {
    try {
      return new URL(p.backendUrl).origin === origin;
    } catch {
      return false;
    }
  });
}
