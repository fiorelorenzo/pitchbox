// LOR-156: scripts/stripe-setup.ts used to create both the production and the
// preview webhook endpoint in whichever mode it ran, leaving the account with
// four endpoints - half of which can never verify a signature, since a
// deployment only ever holds its own mode's signing secret. These are the
// pure decisions the fix turns on, unit-tested here because both scripts call
// the real Stripe API at import time and cannot be exercised without a
// credential.
import { describe, expect, it } from 'vitest';
import {
  endpointBelongsToMode,
  stripeModeFromKey,
  webhookEndpointTargets,
} from '../src/stripe/webhook-endpoints.js';

const ORIGINS = { app: 'https://app.pitchbox.app', preview: 'https://preview.pitchbox.app' };

describe('stripeModeFromKey', () => {
  it('reads live mode off a live secret key', () => {
    expect(stripeModeFromKey('sk_live_abc123')).toBe('live');
  });

  it('reads test mode off a test secret key', () => {
    expect(stripeModeFromKey('sk_test_abc123')).toBe('test');
  });

  it('throws on a key that is neither live nor test', () => {
    expect(() => stripeModeFromKey('whsec_abc123')).toThrow(
      /does not look like a Stripe secret key/,
    );
  });
});

describe('webhookEndpointTargets', () => {
  it('gives live mode the app origin and test mode the preview origin', () => {
    const targets = webhookEndpointTargets(ORIGINS);
    expect(targets).toContainEqual({
      mode: 'live',
      label: 'production',
      url: 'https://app.pitchbox.app/api/stripe/webhook',
    });
    expect(targets).toContainEqual({
      mode: 'test',
      label: 'preview',
      url: 'https://preview.pitchbox.app/api/stripe/webhook',
    });
  });
});

describe('endpointBelongsToMode', () => {
  it('accepts the production URL for live mode', () => {
    expect(
      endpointBelongsToMode('https://app.pitchbox.app/api/stripe/webhook', 'live', ORIGINS),
    ).toBe(true);
  });

  it('accepts the preview URL for test mode', () => {
    expect(
      endpointBelongsToMode('https://preview.pitchbox.app/api/stripe/webhook', 'test', ORIGINS),
    ).toBe(true);
  });

  // This is the exact bug: stripe-setup.ts created the preview endpoint even
  // when it was handed a live key, and the reverse in test mode. A regression
  // here means the setup script starts recreating the mismatched pair again.
  it('rejects the preview URL for live mode', () => {
    expect(
      endpointBelongsToMode('https://preview.pitchbox.app/api/stripe/webhook', 'live', ORIGINS),
    ).toBe(false);
  });

  it('rejects the production URL for test mode', () => {
    expect(
      endpointBelongsToMode('https://app.pitchbox.app/api/stripe/webhook', 'test', ORIGINS),
    ).toBe(false);
  });

  it('rejects a URL naming neither known origin', () => {
    expect(
      endpointBelongsToMode('https://staging.pitchbox.app/api/stripe/webhook', 'live', ORIGINS),
    ).toBe(false);
  });
});
