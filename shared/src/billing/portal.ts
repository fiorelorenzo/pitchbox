// The customer portal is where a plan changes and a card is updated (#552).
// Every change made there comes back as a `customer.subscription.updated`
// or `.deleted` webhook (#551), so this module writes nothing either.
import { eq } from 'drizzle-orm';
import { organizations } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { StripeClient } from '../stripe/client.js';

export class NoStripeCustomerError extends Error {}

/**
 * Starts a billing portal session for the org's Stripe customer, pinned to
 * `portalConfiguration` when the deployment has one
 * (`STRIPE_PORTAL_CONFIGURATION`, `docs/billing.md`'s environment table).
 * Throws `NoStripeCustomerError` for an org with no customer yet (the
 * free-plan case, docs/billing.md #552: "the button offers checkout
 * instead") - the caller decides what that looks like in the response,
 * this module never creates a customer just to open a portal on it.
 */
export async function createPortalSession(
  db: Db,
  stripe: StripeClient,
  args: { orgId: number; returnUrl: string; portalConfiguration: string | null },
): Promise<{ url: string }> {
  const [org] = await db
    .select({ stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(eq(organizations.id, args.orgId))
    .limit(1);
  if (!org?.stripeCustomerId) {
    throw new NoStripeCustomerError(`org ${args.orgId} has no Stripe customer`);
  }
  const session = await stripe.createPortalSession({
    customer: org.stripeCustomerId,
    return_url: args.returnUrl,
    configuration: args.portalConfiguration ?? undefined,
  });
  return { url: session.url };
}
