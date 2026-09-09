/**
 * Reads the deployment's Stripe configuration straight from the environment,
 * the same convention `shared/src/mail/env.ts` uses for a deployment-level
 * secret: read once from `process.env`, never persisted to the database or
 * exposed on a Settings page. `PITCHBOX_BILLING` is the feature flag (a
 * self-host build never sets it, and the docker-compose/`.env.example`
 * default is unset); `STRIPE_SECRET_KEY` is the credential. Either one
 * missing collapses to `{ enabled: false }` rather than a client that only
 * fails once it tries to call Stripe - the same "half-configured provider
 * must not become a transport" rule `shared/src/mail/registry.ts` documents,
 * applied to a single provider instead of a choice between several.
 *
 * `STRIPE_WEBHOOK_SECRET` and `STRIPE_PORTAL_CONFIGURATION` are optional on
 * top of that: the webhook route 404s without a secret (nothing to verify
 * a signature against), and the portal route falls back to the account's
 * default configuration without a pinned one - see `docs/billing.md`'s
 * environment table.
 */
export type StripeEnv =
  | { enabled: false }
  | {
      enabled: true;
      secretKey: string;
      webhookSecret: string | null;
      portalConfiguration: string | null;
    };

/**
 * Managed Payments requires this version or later (`docs/billing.md`,
 * "Checkout Sessions must set managed_payments[enabled]=true and use API
 * version 2025-03-31.basil or later"). Pinned as a constant, not read from
 * the environment, because the app's Checkout/portal payloads are written
 * against this exact shape - `2025-03-31.basil` moved `current_period_start`
 * / `current_period_end` off the Subscription object onto each subscription
 * item (confirmed against the real test account, `shared/src/stripe/client.ts`),
 * so silently floating to a newer version could change the response shape
 * again without anything here noticing.
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';

export function loadStripeEnv(env: Record<string, string | undefined> = process.env): StripeEnv {
  if (env.PITCHBOX_BILLING !== 'on') return { enabled: false };
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    console.warn(
      '[stripe] PITCHBOX_BILLING=on but STRIPE_SECRET_KEY is not set - billing routes will 404',
    );
    return { enabled: false };
  }
  return {
    enabled: true,
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION?.trim() || null,
  };
}
