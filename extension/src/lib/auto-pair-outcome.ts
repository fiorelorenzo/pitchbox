/**
 * Outcome of a single `runAutoPair()` attempt (see content/auto-pair.ts).
 * Shared between the content script, which determines the outcome, and the
 * Connection card, which surfaces it, so both sides speak the same vocabulary
 * over the `pitchbox:auto-pair-outcome` runtime message.
 */
export type AutoPairOutcome =
  | { kind: 'paired' }
  | { kind: 'already-paired' }
  | { kind: 'no-dashboard' }
  | { kind: 'unauthorized' }
  | { kind: 'network-error' }
  | { kind: 'server-error'; httpStatus?: number };

/**
 * i18n key for the message the Connection card should show for `outcome`,
 * or null when the outcome is a success and clears any prior error instead.
 */
export function autoPairOutcomeMessageKey(outcome: AutoPairOutcome): string | null {
  switch (outcome.kind) {
    case 'paired':
    case 'already-paired':
      return null;
    case 'unauthorized':
      return 'dashboard.connection.pair-error-unauthorized';
    case 'no-dashboard':
      return 'dashboard.connection.pair-error-no-dashboard';
    case 'network-error':
      return 'dashboard.connection.pair-error-network';
    case 'server-error':
      return 'dashboard.connection.pair-error-server';
  }
}
