// A failed payment's grace window (#554). `invoice.payment_failed` flips a
// subscription to `past_due` (webhook.ts's `syncSubscriptionFromStripe`
// mirrors Stripe's own status verbatim, no state of our own); this module
// answers the one question that status alone cannot: since when has payment
// actually been failing. Stripe's Smart Retries re-fire `invoice.payment_failed`
// on every reattempt while the subscription stays `past_due` throughout, so a
// second (or fifth) failure must never look like a fresh one - the org gets
// GRACE_PERIOD_DAYS from the *first* failure, not from whichever delivery
// happened to arrive most recently.
//
// No dedicated column for this: `stripe_events` (webhook.ts's own idempotency
// ledger) already records every delivery with a real timestamp
// (`received_at`), so "since when" is "the earliest `invoice.payment_failed`
// after the most recent `invoice.paid`" for the subscription - an ordinary
// read over data the webhook was already writing, rather than a second
// timestamp that would need to be kept in lockstep with `org_subscriptions.status`.
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { schema } from '../db/client.js';

// Loose on purpose (matches shared/src/orgs.ts's own alias): a real `Db`
// (shared/src/db/client.ts) and a `db.transaction` callback's `tx` are both
// assignable to this, and webhook.ts calls `pastDueSince` from inside the
// same transaction as the subscription row it just wrote.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export const GRACE_PERIOD_DAYS = 7;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/**
 * The instant `subscriptionId` most recently started failing to pay, or
 * `null` if there is no unrecovered failure on record. Reads the ledger
 * rather than `org_subscriptions.status` itself - the caller already knows
 * the subscription is `past_due` and wants the moment that began.
 */
export async function pastDueSince(db: Db, subscriptionId: string): Promise<Date | null> {
  // Shared with webhook.ts's own `InvoiceObjectSchema`: an Invoice event's
  // `data.object.subscription` names the subscription it belongs to.
  const belongsToSubscription = sql`${schema.stripeEvents.payload}->'data'->'object'->>'subscription' = ${subscriptionId}`;

  const [lastPaid] = await db
    .select({ at: schema.stripeEvents.receivedAt })
    .from(schema.stripeEvents)
    .where(and(eq(schema.stripeEvents.type, 'invoice.paid'), belongsToSubscription))
    .orderBy(desc(schema.stripeEvents.receivedAt))
    .limit(1);

  const recoveredAt = lastPaid?.at ?? new Date(0);

  const [firstFailureSinceRecovery] = await db
    .select({ at: schema.stripeEvents.receivedAt })
    .from(schema.stripeEvents)
    .where(
      and(
        eq(schema.stripeEvents.type, 'invoice.payment_failed'),
        belongsToSubscription,
        gt(schema.stripeEvents.receivedAt, recoveredAt),
      ),
    )
    .orderBy(asc(schema.stripeEvents.receivedAt))
    .limit(1);

  return firstFailureSinceRecovery?.at ?? null;
}

/** The instant the grace window granted at `since` ends. */
export function graceEndsAt(since: Date): Date {
  return new Date(since.getTime() + GRACE_PERIOD_MS);
}
