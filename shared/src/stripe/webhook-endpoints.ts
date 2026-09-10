/**
 * A Stripe webhook endpoint is invoked in the mode it was created in, and a
 * deployment only ever holds one mode's signing secret - so exactly one
 * endpoint belongs to each mode. `scripts/stripe-setup.ts` used to create
 * both `app.pitchbox.app` and `preview.pitchbox.app` in whichever mode it
 * ran, leaving the account with four endpoints: production and preview
 * registered in live mode, and again in test mode. Half of those deliveries
 * can never verify a signature (docs/billing.md "Production and preview have
 * separate webhook endpoints"), and a real payment posting to the wrong-mode
 * endpoint gets retried on a 400 `invalid_signature` until Stripe disables it.
 *
 * These two functions are the pure decision the fix turns on: which mode a
 * secret key names, and which of the two known origins belongs to that mode.
 * Kept out of `scripts/stripe-setup.ts` and `scripts/stripe-probe.ts`, both
 * of which call the real Stripe API at import time, so this can be
 * unit-tested without a network call or a credential.
 */
export type StripeMode = 'live' | 'test';

export function stripeModeFromKey(secretKey: string): StripeMode {
  if (secretKey.startsWith('sk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_')) return 'test';
  throw new Error(
    `STRIPE_SECRET_KEY does not look like a Stripe secret key (expected sk_live_... or sk_test_...): ${secretKey.slice(0, 8)}...`,
  );
}

export type WebhookOrigins = { app: string; preview: string };

export type WebhookEndpointTarget = { mode: StripeMode; label: string; url: string };

/** The one webhook endpoint each mode owns: live mode gets the production
 * origin, test mode gets preview - never both, and never swapped, since
 * preview only ever holds a test-mode signing secret. */
export function webhookEndpointTargets(origins: WebhookOrigins): WebhookEndpointTarget[] {
  return [
    { mode: 'live', label: 'production', url: `${origins.app}/api/stripe/webhook` },
    { mode: 'test', label: 'preview', url: `${origins.preview}/api/stripe/webhook` },
  ];
}

/** True when `url` is the endpoint `mode` is supposed to hold; false for the
 * other mode's endpoint (which must be reported and disabled, never
 * created) and for a URL naming neither known origin. */
export function endpointBelongsToMode(
  url: string,
  mode: StripeMode,
  origins: WebhookOrigins,
): boolean {
  return webhookEndpointTargets(origins).some((t) => t.mode === mode && t.url === url);
}
