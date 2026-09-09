// One Stripe customer per organization (#550), created lazily and reused -
// never per user, because the subscription belongs to the tenant and seats
// are an org attribute (docs/billing.md, `organizations.stripe_customer_id`
// in `db/schema.ts`). This is the only writer of that column.
import { and, eq, isNull } from 'drizzle-orm';
import { memberships, organizations, users } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { StripeClient } from '../stripe/client.js';

/** The org's oldest owner's email, or `null` if the org has no owner with a
 * verified account email yet (self-host with auth off, or a pre-#530
 * account that never set one). Stripe's `email` on a customer is optional,
 * so a `null` here just means the Checkout page collects it instead. */
async function ownerEmail(db: Db, orgId: number): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.role, 'owner')))
    .orderBy(memberships.userId)
    .limit(1);
  return row?.email ?? null;
}

/**
 * Returns the org's Stripe customer id, creating one on Stripe and
 * persisting it to `organizations.stripe_customer_id` if this is the org's
 * first checkout. Two concurrent first checkouts for one org race on the
 * same `UPDATE ... WHERE stripe_customer_id IS NULL`: only one of them
 * actually claims the column (the loser's own freshly-created Stripe
 * customer is simply never referenced again - an orphaned test-mode
 * customer object costs nothing and is not worth a compensating delete),
 * and both callers end up returning the id that won, so the org never ends
 * up with two live customer ids across two `org_subscriptions` rows.
 */
export async function ensureStripeCustomer(
  db: Db,
  stripe: StripeClient,
  orgId: number,
): Promise<string> {
  const [org] = await db
    .select({ slug: organizations.slug, stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`org ${orgId} does not exist`);
  if (org.stripeCustomerId) return org.stripeCustomerId;

  const email = await ownerEmail(db, orgId);
  const customer = await stripe.createCustomer({
    email: email ?? undefined,
    metadata: { organization_id: String(orgId), organization_slug: org.slug },
  });

  const [claimed] = await db
    .update(organizations)
    .set({ stripeCustomerId: customer.id })
    .where(and(eq(organizations.id, orgId), isNull(organizations.stripeCustomerId)))
    .returning({ stripeCustomerId: organizations.stripeCustomerId });
  if (!claimed) {
    const [row] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (row?.stripeCustomerId) return row.stripeCustomerId;
    throw new Error(`org ${orgId} lost its stripe_customer_id race with no winner`);
  }
  return claimed.stripeCustomerId ?? customer.id;
}
