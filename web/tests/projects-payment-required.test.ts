// #554: "no new projects" for a read-only org - the same enforcement point
// as projects-plan-limit.test.ts's ceiling, checked first, with its own
// `plan_payment_required` code.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import { POST as projectsPost } from '../src/routes/api/projects/+server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM stripe_events`);
  await getDb().execute(sql`DELETE FROM org_subscriptions`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makePastDueOrg(slug: string, failedDaysAgo: number): Promise<number> {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
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
    planId: 'growth',
    status: 'past_due',
    currentPeriodStart: new Date(Date.now() - 20 * DAY_MS),
    currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
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
  const failedEventId = `evt_${randomUUID()}`;
  const failedAt = new Date(Date.now() - failedDaysAgo * DAY_MS);
  await db.insert(schema.stripeEvents).values({
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
  return org.id;
}

function postEvent(orgId: number, body: unknown): Parameters<typeof projectsPost>[0] {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as Parameters<typeof projectsPost>[0];
}

describe('POST /api/projects is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('refuses with plan_payment_required once the grace window has elapsed, creating nothing', async () => {
    const orgId = await makePastDueOrg('projects-payment-required-over', GRACE_PERIOD_DAYS + 1);

    const res = await projectsPost(
      postEvent(orgId, { name: 'Should not exist', defaultAgentRunner: 'cloud' }),
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('plan_payment_required');

    const rows = await getDb()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, orgId));
    expect(rows).toHaveLength(0);
  });

  it('creates the project normally while still inside the grace window', async () => {
    const orgId = await makePastDueOrg('projects-payment-required-grace', 3);

    const res = await projectsPost(
      postEvent(orgId, { name: 'Still fine', defaultAgentRunner: 'cloud' }),
    );

    expect(res.status).toBe(201);
  });
});
