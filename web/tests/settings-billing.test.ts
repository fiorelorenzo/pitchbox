// #555: the settings/billing loader gates on admin+ role like retention/
// security, and on `currentEdition() === 'cloud'` for anything past the
// self-host early return - self-host has no plan concept at all
// (shared/src/plans.ts's resolveEntitlements). Every number asserted here
// comes straight off `getOrgUsage`/`resolveEntitlements`; this file never
// re-derives a limit, it only checks the loader handed the page what those
// two functions actually returned for each state.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import { load } from '../src/routes/settings/billing/+page.server.js';
import type { BillingPageData } from '../src/routes/settings/billing/+page.server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const billingLoad = load as (event: RequestEvent) => Promise<BillingPageData>;

function loaderEvent(orgId: number, role: 'member' | 'admin' | 'owner'): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
  } as unknown as RequestEvent;
}

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') {
      return e.status;
    }
    return 500;
  }
}

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM stripe_events`);
  await db.execute(sql`DELETE FROM org_subscriptions`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makeFreeOrg(slug: string): Promise<number> {
  const [org] = await getDb().insert(schema.organizations).values({ slug, name: slug }).returning();
  return org.id;
}

async function makeGrantOrg(slug: string, planId: string): Promise<number> {
  const [org] = await getDb()
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: planId, planSource: 'grant' })
    .returning();
  return org.id;
}

async function makeSubscriptionOrg(
  slug: string,
  opts: {
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
    planId?: string;
    pendingPlanId?: string;
    pendingPlanEffectiveAt?: Date;
  },
): Promise<{ orgId: number; subscriptionId: string; customerId: string }> {
  const db = getDb();
  const planId = opts.planId ?? 'growth';
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: planId, planSource: 'stripe' })
    .returning();
  const customerId = `cus_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  await db
    .update(schema.organizations)
    .set({ stripeCustomerId: customerId })
    .where(eq(schema.organizations.id, org.id));
  await db.insert(schema.orgSubscriptions).values({
    organizationId: org.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    planId,
    status: opts.status,
    currentPeriodStart: opts.currentPeriodStart,
    currentPeriodEnd: opts.currentPeriodEnd,
    cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
    pendingPlanId: opts.pendingPlanId ?? null,
    pendingPlanEffectiveAt: opts.pendingPlanEffectiveAt ?? null,
    limitRuns: 2000,
    limitSuggestions: 2000,
    limitProjects: 10,
    limitSeats: 3,
    limitDevices: 10,
    limitConcurrency: 4,
    limitBudgetUsd: '30.00',
    limitRetentionDays: 90,
    limitPremiumModels: true,
  });
  return { orgId: org.id, subscriptionId, customerId };
}

async function markPastDue(subscriptionId: string, customerId: string, daysAgo: number) {
  const failedEventId = `evt_${randomUUID()}`;
  const failedAt = new Date(Date.now() - daysAgo * DAY_MS);
  await getDb()
    .insert(schema.stripeEvents)
    .values({
      id: failedEventId,
      type: 'invoice.payment_failed',
      receivedAt: failedAt,
      processedAt: failedAt,
      payload: {
        id: failedEventId,
        type: 'invoice.payment_failed',
        created: Math.floor(failedAt.getTime() / 1000),
        data: { object: { subscription: subscriptionId, customer: customerId } },
      },
    });
}

describe('settings/billing loader (#555)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;

  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });

  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('a member is forbidden (403)', async () => {
    const orgId = await makeFreeOrg('billing-role-member');
    expect(await statusOf(() => billingLoad(loaderEvent(orgId, 'member')))).toBe(403);
  });

  it('an admin can load the page', async () => {
    const orgId = await makeFreeOrg('billing-role-admin');
    expect(await statusOf(() => billingLoad(loaderEvent(orgId, 'admin')))).toBe(200);
  });

  it('self-host: unlimited, no plan card', async () => {
    delete process.env.PITCHBOX_EDITION;
    const orgId = await makeFreeOrg('billing-self-host');
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    expect(data).toEqual({ selfHost: true });
  });

  it('free org: no subscription, offers plans to pick', async () => {
    const orgId = await makeFreeOrg('billing-free');
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.planId).toBe('free');
    expect(data.source).toBe('default');
    expect(data.hasStripeCustomer).toBe(false);
    expect(data.cancelAtPeriodEnd).toBe(false);
    expect(data.graceEndsAt).toBeNull();
    expect(data.pickablePlans.map((p) => p.id)).toEqual(['solo', 'growth', 'scale']);
    expect(data.usage.runs.limit).toBe(20); // Free's runsPerMonth
  });

  it('active paying plan: portal offered, no grace banner', async () => {
    const now = new Date();
    const { orgId } = await makeSubscriptionOrg('billing-active', {
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
    });
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.source).toBe('subscription');
    expect(data.planId).toBe('growth');
    expect(data.hasStripeCustomer).toBe(true);
    expect(data.status).toBe('active');
    expect(data.interval).toBe('month');
    expect(data.cancelAtPeriodEnd).toBe(false);
    expect(data.readOnly).toBe(false);
    expect(data.graceEndsAt).toBeNull();
    expect(data.pendingPlanName).toBeNull();
    expect(data.pendingPlanEffectiveAt).toBeNull();
    expect(data.usage.runs.limit).toBe(2000); // the subscription's own mirrored limit
  });

  it('a scheduled downgrade (LOR-157): the pending plan and date are surfaced next to the current plan', async () => {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 20 * DAY_MS);
    const { orgId } = await makeSubscriptionOrg('billing-pending-downgrade', {
      status: 'active',
      currentPeriodStart: new Date(now.getTime() - 10 * DAY_MS),
      currentPeriodEnd: periodEnd,
      pendingPlanId: 'solo',
      pendingPlanEffectiveAt: periodEnd,
    });
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    // Still Growth until the schedule actually applies - only the pending
    // fields, not `planId` itself, name the future change.
    expect(data.planId).toBe('growth');
    expect(data.pendingPlanName).toBe('Pitchbox Solo');
    expect(data.pendingPlanEffectiveAt).toBe(periodEnd.toISOString());
  });

  it('a yearly period resolves interval "year"', async () => {
    const now = new Date();
    const { orgId } = await makeSubscriptionOrg('billing-yearly', {
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 365 * DAY_MS),
    });
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.interval).toBe('year');
  });

  it('past_due inside the grace window: banner named with the real date, still not read-only', async () => {
    const now = new Date();
    const { orgId, subscriptionId, customerId } = await makeSubscriptionOrg('billing-grace', {
      status: 'past_due',
      currentPeriodStart: new Date(now.getTime() - 20 * DAY_MS),
      currentPeriodEnd: new Date(now.getTime() + 10 * DAY_MS),
    });
    await markPastDue(subscriptionId, customerId, GRACE_PERIOD_DAYS - 2);
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.status).toBe('past_due');
    expect(data.readOnly).toBe(false);
    expect(data.graceEndsAt).not.toBeNull();
    expect(new Date(data.graceEndsAt as string).getTime()).toBeGreaterThan(now.getTime());
    // Still a live customer, so the portal is still the right action.
    expect(data.hasStripeCustomer).toBe(true);
  });

  it('past the grace window: read-only, louder', async () => {
    const now = new Date();
    const { orgId, subscriptionId, customerId } = await makeSubscriptionOrg('billing-readonly', {
      status: 'past_due',
      currentPeriodStart: new Date(now.getTime() - 20 * DAY_MS),
      currentPeriodEnd: new Date(now.getTime() + 10 * DAY_MS),
    });
    await markPastDue(subscriptionId, customerId, GRACE_PERIOD_DAYS + 2);
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.status).toBe('past_due');
    expect(data.readOnly).toBe(true);
    expect(data.graceEndsAt).not.toBeNull();
    expect(new Date(data.graceEndsAt as string).getTime()).toBeLessThan(now.getTime());
  });

  it('cancel_at_period_end set: named with the real date, portal still offered', async () => {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 12 * DAY_MS);
    const { orgId } = await makeSubscriptionOrg('billing-cancelling', {
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.cancelAtPeriodEnd).toBe(true);
    expect(data.currentPeriodEnd).toBe(periodEnd.toISOString());
    expect(data.hasStripeCustomer).toBe(true);
    expect(data.readOnly).toBe(false);
  });

  it('an instance-admin grant: no Stripe customer, so no portal link', async () => {
    const orgId = await makeGrantOrg('billing-grant', 'growth');
    const data = await billingLoad(loaderEvent(orgId, 'admin'));
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.source).toBe('grant');
    expect(data.planId).toBe('growth');
    expect(data.hasStripeCustomer).toBe(false);
    expect(data.status).toBeNull();
    expect(data.usage.runs.limit).toBe(2000); // catalogue's growth number, not a subscription row
  });
});
