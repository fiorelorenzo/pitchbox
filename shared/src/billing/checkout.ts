// A Checkout session per plan and interval (#550). This route never writes
// a plan: `org_subscriptions`/`organizations.plan` are the webhook's alone
// (#551) - a success redirect that optimistically upgrades here is exactly
// the bug that lets somebody abandon payment and keep the plan.
import { type PlanId, stripeLookupKey } from '../plans.js';
import type { Db } from '../db/client.js';
import type { StripeClient } from '../stripe/client.js';
import { ensureStripeCustomer } from './customer.js';

export class UnknownPriceError extends Error {}

export type CreateCheckoutSessionArgs = {
  orgId: number;
  planId: PlanId;
  interval: 'month' | 'year';
  successUrl: string;
  cancelUrl: string;
};

/**
 * Starts a subscription Checkout session for `args.planId`/`args.interval`,
 * resolved to a Stripe price by `lookup_key` (docs/billing.md - the app
 * never accepts a price id from the caller). Every parameter Managed
 * Payments rejects (`automatic_tax`, `tax_id_collection`, `payment_method_*`,
 * `customer_update[name/address]`, `shipping_*`,
 * `subscription_data.invoice_settings`, ...) is simply never set here -
 * confirmed against a real test-mode session for `pitchbox_growth_monthly`,
 * see the PR for the verbatim Stripe errors this omission avoids.
 */
export async function createCheckoutSession(
  db: Db,
  stripe: StripeClient,
  args: CreateCheckoutSessionArgs,
): Promise<{ url: string }> {
  const lookupKey = stripeLookupKey(args.planId, args.interval === 'month' ? 'monthly' : 'yearly');
  if (!lookupKey) throw new UnknownPriceError(`plan ${args.planId} has no Stripe price`);
  const price = await stripe.getPriceByLookupKey(lookupKey);
  if (!price) throw new UnknownPriceError(`no active Stripe price for lookup key ${lookupKey}`);

  const customerId = await ensureStripeCustomer(db, stripe, args.orgId);
  const session = await stripe.createCheckoutSession({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: String(args.orgId),
    subscription_data: { metadata: { organization_id: String(args.orgId) } },
    allow_promotion_codes: true,
    managed_payments: { enabled: true },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  if (!session.url) throw new Error(`Stripe returned no url for checkout session ${session.id}`);
  return { url: session.url };
}
