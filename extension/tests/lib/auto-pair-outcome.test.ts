import { describe, expect, it } from 'vitest';
import {
  autoPairOutcomeMessageKey,
  type AutoPairOutcome,
} from '../../src/lib/auto-pair-outcome.js';
import { translate } from '../../src/lib/i18n/index.js';

describe('autoPairOutcomeMessageKey', () => {
  it('needs no message for a successful pairing', () => {
    expect(autoPairOutcomeMessageKey({ kind: 'paired' })).toBeNull();
  });

  it('needs no message when already paired with this backend', () => {
    expect(autoPairOutcomeMessageKey({ kind: 'already-paired' })).toBeNull();
  });

  it('maps a 401 to the "not signed in" key, distinct from every other failure', () => {
    expect(autoPairOutcomeMessageKey({ kind: 'unauthorized' })).toBe(
      'dashboard.connection.pair-error-unauthorized',
    );
  });

  it('maps a missing/unreachable dashboard tab to its own key', () => {
    expect(autoPairOutcomeMessageKey({ kind: 'no-dashboard' })).toBe(
      'dashboard.connection.pair-error-no-dashboard',
    );
  });

  it('maps a fetch failure to its own key', () => {
    expect(autoPairOutcomeMessageKey({ kind: 'network-error' })).toBe(
      'dashboard.connection.pair-error-network',
    );
  });

  it('maps any other non-OK response to its own key, regardless of status', () => {
    const withStatus: AutoPairOutcome = { kind: 'server-error', httpStatus: 500 };
    const withoutStatus: AutoPairOutcome = { kind: 'server-error' };
    expect(autoPairOutcomeMessageKey(withStatus)).toBe('dashboard.connection.pair-error-server');
    expect(autoPairOutcomeMessageKey(withoutStatus)).toBe('dashboard.connection.pair-error-server');
  });

  it('produces four distinct failure messages, none of them a generic fallback', () => {
    const failureKeys = (
      ['unauthorized', 'no-dashboard', 'network-error', 'server-error'] as const
    ).map((kind) => autoPairOutcomeMessageKey({ kind }));
    expect(new Set(failureKeys).size).toBe(4);
    for (const key of failureKeys) {
      const message = translate('en', key as string);
      expect(message).not.toBe(key); // resolves to real copy, not a missing-key fallback
      expect(message.toLowerCase()).not.toContain('something went wrong');
    }
  });

  it('resolves every failure key to real, distinct English and Italian copy', () => {
    for (const key of [
      'dashboard.connection.pair-error-unauthorized',
      'dashboard.connection.pair-error-no-dashboard',
      'dashboard.connection.pair-error-network',
      'dashboard.connection.pair-error-server',
    ]) {
      expect(translate('en', key)).not.toBe(key);
      expect(translate('it', key)).not.toBe(key);
      expect(translate('it', key)).not.toBe(translate('en', key));
    }
  });

  it('the 401 message tells the user what to do, not the status code', () => {
    const message = translate('en', 'dashboard.connection.pair-error-unauthorized');
    expect(message).not.toMatch(/401/);
    expect(message.toLowerCase()).toContain('sign in');
  });
});
