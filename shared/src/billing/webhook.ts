// The Stripe webhook is the only writer of subscription state (#551).
// Every exported entry point here assumes the caller (the web route) has
// already verified `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET` - this
// module never sees a request that failed that check, and never touches the
// database before it passes.
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { organizations, orgSubscriptions, stripeEvents } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { recordInstanceAudit } from '../instance-audit.js';
import { normalizePlanId, type PlanId } from '../plans.js';
import { setOrgPlan } from '../orgs.js';
import { notify } from '../notifications.js';
import { pastDueSince, graceEndsAt } from './grace.js';
import type {
  StripeClient,
  StripeEvent,
  StripeMetadata,
  StripeSubscription,
  StripeSubscriptionSchedule,
} from '../stripe/client.js';

/** The system actor recorded on every audit row this module writes -
 * `recordInstanceAudit` only ever reads `.username` off this, `id` is
 * unused but required by its `InstanceAuditActor` type. */
const WEBHOOK_ACTOR = { id: -1, username: 'stripe:webhook' };

export type ApplyOutcome =
  'duplicate' | 'unknown-customer' | 'stale' | 'no-op' | 'ignored' | 'applied';

export type ApplyResult = { outcome: ApplyOutcome; detail?: string };

/**
 * The Stripe product metadata this app defines (`scripts/stripe-setup.ts`,
 * docs/billing.md "The plan catalogue lives in Stripe, not in the code")
 * turned into `org_subscriptions` columns. The string `'0'` on any `limit_*`
 * key means unlimited on that axis and becomes a real SQL `NULL`, never a
 * stored `0` - the same convention the setup script's own comments use.
 */
export function limitsFromProductMetadata(metadata: StripeMetadata): {
  planId: PlanId;
  limitRuns: number | null;
  limitSuggestions: number | null;
  limitProjects: number | null;
  limitSeats: number | null;
  limitDevices: number | null;
  limitConcurrency: number | null;
  limitBudgetUsd: string | null;
  limitRetentionDays: number | null;
  limitPremiumModels: boolean;
} {
  const int = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };
  const budget = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n !== 0 ? n.toFixed(2) : null;
  };
  return {
    planId: normalizePlanId(metadata.plan),
    limitRuns: int(metadata.limit_runs),
    limitSuggestions: int(metadata.limit_suggestions),
    limitProjects: int(metadata.limit_projects),
    limitSeats: int(metadata.limit_seats),
    limitDevices: int(metadata.limit_devices),
    limitConcurrency: int(metadata.limit_concurrency),
    limitBudgetUsd: budget(metadata.limit_budget_usd),
    limitRetentionDays: int(metadata.limit_retention_days),
    limitPremiumModels: metadata.limit_premium_models === 'true',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markProcessed(db: PgDatabase<any, any, any>, eventId: string): Promise<void> {
  await db
    .update(stripeEvents)
    .set({ processedAt: new Date() })
    .where(eq(stripeEvents.id, eventId));
}

/**
 * Reads the plan change a Stripe Subscription Schedule has deferred to a
 * future date (LOR-157) - the downgrade-to-period-end path docs/billing.md
 * describes under "Where a customer manages a subscription": the portal
 * leaves the subscription on its current price and creates a two-phase
 * schedule instead, so the events `syncSubscriptionFromStripe` already
 * handles never see the change on the subscription object itself. No
 * webhook event this module subscribes to names a schedule as its own
 * type; `scheduleId` comes off `StripeSubscription.schedule` on whatever
 * event triggered the sync.
 *
 * Returns `'unknown'` when the schedule cannot be read - a Stripe API
 * error, or a shape this function does not recognise (a next phase whose
 * price/product was not expanded). The caller leaves
 * `org_subscriptions.pending_plan_id`/`pending_plan_effective_at` exactly
 * as they were rather than overwrite a real pending change with a guess:
 * a webhook that throws is a webhook Stripe retries (#551), and this
 * lookup must never be why one does. Returns `'none'` when the schedule
 * genuinely names no pending change - absent, finished, only one phase,
 * or its next phase resolves to the plan already mirrored - and the
 * caller clears both columns for that.
 */
export async function resolvePendingPlanChange(
  stripe: StripeClient,
  scheduleId: string | null | undefined,
  currentPlanId: PlanId,
): Promise<'unknown' | 'none' | { planId: PlanId; effectiveAt: Date }> {
  if (!scheduleId) return 'none';
  let schedule: StripeSubscriptionSchedule;
  try {
    schedule = await stripe.getSubscriptionSchedule(scheduleId);
  } catch {
    return 'unknown';
  }
  const currentPhase = schedule.current_phase;
  if (schedule.status !== 'active' || schedule.phases.length < 2 || !currentPhase) {
    return 'none';
  }
  const currentIndex = schedule.phases.findIndex((p) => p.start_date === currentPhase.start_date);
  const next = currentIndex === -1 ? undefined : schedule.phases[currentIndex + 1];
  if (!next) return 'none';
  const item = next.items[0];
  if (!item || typeof item.price === 'string' || typeof item.price.product === 'string') {
    return 'unknown';
  }
  const planId = normalizePlanId(item.price.product.metadata.plan);
  return planId === currentPlanId
    ? 'none'
    : { planId, effectiveAt: new Date(next.start_date * 1000) };
}

/**
 * Refetches `subscriptionId` live from Stripe - never trusts the possibly
 * stale object embedded in the webhook event, Stripe's own recommendation
 * for handling delivery order it does not guarantee - and mirrors it onto
 * `org_subscriptions`/`organizations` wholesale, in one transaction with
 * marking the ledger row processed.
 *
 * Version guard: `2025-03-31.basil` moved `current_period_start`/`_end` off
 * the Subscription object onto each subscription item (confirmed against
 * the real test account - see the PR), so the item's own
 * `current_period_end` is what this reads. It is also this function's
 * out-of-order marker: an incoming value strictly less than what is already
 * stored would mean this event describes an earlier billing period than one
 * already recorded, so it is ignored rather than applied. Equal or greater
 * is applied even when nothing period-related changed (a plan swap mid
 * cycle typically leaves `current_period_end` unchanged) - only a real step
 * backwards is "stale". `event.created` is not used for this at all: two
 * events can share the same second (Stripe's own documented limitation),
 * while this field only moves forward in the object it actually describes.
 */
export async function syncSubscriptionFromStripe(
  db: Db,
  stripe: StripeClient,
  subscriptionId: string,
  eventId: string,
): Promise<ApplyResult> {
  const sub = await stripe.getSubscription(subscriptionId);
  const item = sub.items.data[0];
  if (!item) {
    throw new Error(`subscription ${subscriptionId} has no items`);
  }
  const product = item.price.product;
  if (typeof product === 'string') {
    throw new Error(`subscription ${subscriptionId}'s product was not expanded`);
  }
  const limits = limitsFromProductMetadata(product.metadata);
  // A schedule lookup is a second Stripe API call, made here rather than
  // inside the transaction below for the same reason `getSubscription`
  // above already is: a DB transaction has no business sitting open
  // across a network call.
  const pendingChange = await resolvePendingPlanChange(stripe, sub.schedule, limits.planId);

  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({
        id: organizations.id,
        plan: organizations.plan,
        planSource: organizations.planSource,
      })
      .from(organizations)
      .where(eq(organizations.stripeCustomerId, sub.customer))
      .limit(1);
    if (!org) {
      await markProcessed(tx, eventId);
      return { outcome: 'unknown-customer' as const, detail: sub.customer };
    }

    const [existing] = await tx
      .select({
        currentPeriodEnd: orgSubscriptions.currentPeriodEnd,
        status: orgSubscriptions.status,
      })
      .from(orgSubscriptions)
      .where(eq(orgSubscriptions.organizationId, org.id))
      .limit(1);
    const currentPeriodEnd = new Date(item.current_period_end * 1000);
    if (existing && currentPeriodEnd.getTime() < existing.currentPeriodEnd.getTime()) {
      await markProcessed(tx, eventId);
      return { outcome: 'stale' as const };
    }

    const row = {
      organizationId: org.id,
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      planId: limits.planId,
      status: sub.status,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      limitRuns: limits.limitRuns,
      limitSuggestions: limits.limitSuggestions,
      limitProjects: limits.limitProjects,
      limitSeats: limits.limitSeats,
      limitDevices: limits.limitDevices,
      limitConcurrency: limits.limitConcurrency,
      limitBudgetUsd: limits.limitBudgetUsd,
      limitRetentionDays: limits.limitRetentionDays,
      limitPremiumModels: limits.limitPremiumModels,
      updatedAt: new Date(),
    };
    await tx
      .insert(orgSubscriptions)
      .values(row)
      .onConflictDoUpdate({ target: orgSubscriptions.organizationId, set: row });

    // `pendingChange` is `'unknown'` only when the schedule lookup above
    // could not tell what is pending (LOR-157) - the two columns are left
    // exactly as they were rather than overwritten with a guess.
    if (pendingChange !== 'unknown') {
      await tx
        .update(orgSubscriptions)
        .set({
          pendingPlanId: pendingChange === 'none' ? null : pendingChange.planId,
          pendingPlanEffectiveAt: pendingChange === 'none' ? null : pendingChange.effectiveAt,
        })
        .where(eq(orgSubscriptions.organizationId, org.id));
    }

    // A grant survives whatever Stripe says about the same org (docs/billing.md,
    // shared/src/plans.ts's resolveEntitlements) - the row above still mirrors
    // Stripe's state for visibility, but `organizations.plan`/`plan_source`
    // themselves are left alone.
    if (org.planSource !== 'grant') {
      await setOrgPlan(tx, org.id, limits.planId, 'stripe');
    }

    await recordInstanceAudit(tx, {
      key: `billing.subscription:${org.id}`,
      actor: WEBHOOK_ACTOR,
      before: { plan: org.plan, planSource: org.planSource },
      after: {
        plan: org.planSource === 'grant' ? org.plan : limits.planId,
        planSource: org.planSource,
        stripeStatus: sub.status,
        stripeSubscriptionId: sub.id,
      },
    });

    // #554: the grace window's own banner/notification name a real date, so
    // it is stamped once, the moment the subscription actually enters
    // `past_due` - never on a Smart Retries reattempt that leaves it
    // `past_due` again (existing?.status already `past_due` skips this), and
    // never for a grant (docs/billing.md: a grant survives whatever Stripe
    // says about the same org, including a failed payment).
    if (
      org.planSource !== 'grant' &&
      sub.status === 'past_due' &&
      existing?.status !== 'past_due'
    ) {
      const since = (await pastDueSince(tx, sub.id)) ?? new Date();
      const until = graceEndsAt(since);
      await notify(
        tx,
        {
          kind: 'billing_payment_failed',
          title: 'Payment failed - grace period started',
          severity: 'warning',
          body:
            `We could not process your latest payment. Your plan keeps working until ` +
            `${until.toISOString().slice(0, 10)}; update your payment method in the customer ` +
            `portal before then to avoid the account going read-only.`,
          payload: { graceEndsAt: until.toISOString() },
        },
        org.id,
      );
    }

    await markProcessed(tx, eventId);
    return {
      outcome: 'applied' as const,
      detail: org.planSource === 'grant' ? 'grant preserved' : undefined,
    };
  });
}

/**
 * `customer.subscription.deleted`: the subscription is gone (cancelled at
 * Stripe, or removed along with the rest of the customer's data -
 * docs/billing.md "Emails and support"). Drops the org's mirrored row and
 * its plan to free, `organizations`' data untouched - a grant is preserved
 * the same way `syncSubscriptionFromStripe` preserves it.
 */
export async function clearSubscription(
  db: Db,
  customerId: string,
  eventId: string,
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({
        id: organizations.id,
        plan: organizations.plan,
        planSource: organizations.planSource,
      })
      .from(organizations)
      .where(eq(organizations.stripeCustomerId, customerId))
      .limit(1);
    if (!org) {
      await markProcessed(tx, eventId);
      return { outcome: 'unknown-customer' as const, detail: customerId };
    }

    await tx.delete(orgSubscriptions).where(eq(orgSubscriptions.organizationId, org.id));
    if (org.planSource !== 'grant') {
      await setOrgPlan(tx, org.id, 'free', 'stripe');
    }

    await recordInstanceAudit(tx, {
      key: `billing.subscription:${org.id}`,
      actor: WEBHOOK_ACTOR,
      before: { plan: org.plan, planSource: org.planSource },
      after: {
        plan: org.planSource === 'grant' ? org.plan : 'free',
        planSource: org.planSource,
        stripeStatus: 'deleted',
      },
    });

    await markProcessed(tx, eventId);
    return {
      outcome: 'applied' as const,
      detail: org.planSource === 'grant' ? 'grant preserved' : undefined,
    };
  });
}

// The event envelope's `data.object` shape is Stripe's, not ours - each
// schema below validates only the field(s) this module actually reads off
// it, `.strip()`ping the rest (zod's object default), rather than growing a
// full Subscription/Invoice/CheckoutSession type here.
const CheckoutSessionObjectSchema = z.object({ subscription: z.string().nullable() });
const SubscriptionRefObjectSchema = z.object({ id: z.string() });
const SubscriptionCustomerObjectSchema = z.object({ customer: z.string() });
const InvoiceObjectSchema = z.object({ subscription: z.string().nullable() });

/**
 * Applies one verified Stripe event. `event.id` is inserted into
 * `stripe_events` first, before any of the seven event types below are even
 * considered: zero rows affected means this id already exists, and only a
 * row whose `processed_at` is still null - a previous delivery that was
 * recorded but crashed before finishing - gets reprocessed; a fully
 * processed row is a true replay and is left untouched (docs/billing.md's
 * webhook list is the seven event types handled here; anything else is
 * recorded and ignored).
 */
export async function applyStripeEvent(
  db: Db,
  stripe: StripeClient,
  event: StripeEvent,
): Promise<ApplyResult> {
  const inserted = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type, payload: event })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  if (inserted.length === 0) {
    const [existing] = await db
      .select({ processedAt: stripeEvents.processedAt })
      .from(stripeEvents)
      .where(eq(stripeEvents.id, event.id))
      .limit(1);
    if (existing?.processedAt) return { outcome: 'duplicate' };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const parsed = CheckoutSessionObjectSchema.safeParse(event.data.object);
      if (!parsed.success || !parsed.data.subscription) {
        await markProcessed(db, event.id);
        return { outcome: 'ignored', detail: 'checkout session has no subscription' };
      }
      return syncSubscriptionFromStripe(db, stripe, parsed.data.subscription, event.id);
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const parsed = SubscriptionRefObjectSchema.safeParse(event.data.object);
      if (!parsed.success) {
        await markProcessed(db, event.id);
        return { outcome: 'ignored', detail: 'subscription event has no id' };
      }
      return syncSubscriptionFromStripe(db, stripe, parsed.data.id, event.id);
    }
    case 'customer.subscription.deleted': {
      const parsed = SubscriptionCustomerObjectSchema.safeParse(event.data.object);
      if (!parsed.success) {
        await markProcessed(db, event.id);
        return { outcome: 'ignored', detail: 'subscription event has no customer' };
      }
      return clearSubscription(db, parsed.data.customer, event.id);
    }
    case 'customer.subscription.trial_will_end':
      // There is no trial (docs/billing.md, shared/src/plans.ts): Free is
      // the trial and never expires, so this fires without ever meaning
      // anything for us. Subscribed to only because the account carries it
      // regardless; recorded for idempotency, nothing to change.
      await markProcessed(db, event.id);
      return { outcome: 'no-op' };
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      // Both are "go read the subscription's live status again": Stripe
      // itself flips the subscription to `past_due` before/alongside
      // `invoice.payment_failed`, and back before/alongside `invoice.paid`
      // once dunning succeeds - refetching and mirroring wholesale already
      // captures the grace-period transition without this module guessing
      // a status of its own.
      const parsed = InvoiceObjectSchema.safeParse(event.data.object);
      if (!parsed.success || !parsed.data.subscription) {
        await markProcessed(db, event.id);
        return { outcome: 'ignored', detail: 'invoice has no subscription' };
      }
      return syncSubscriptionFromStripe(db, stripe, parsed.data.subscription, event.id);
    }
    default:
      await markProcessed(db, event.id);
      return { outcome: 'ignored', detail: `unhandled event type ${event.type}` };
  }
}

export type { StripeSubscription };
