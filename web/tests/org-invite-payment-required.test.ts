// #554: "no new invites" for a read-only org - the same enforcement point as
// org-invite-plan-limit.test.ts's seat ceiling, checked first, with its own
// `plan_payment_required` code.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import { POST as invitesPost } from '../src/routes/api/orgs/[slug]/invites/+server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  await getDb().execute(sql`DELETE FROM org_invites`);
  await getDb().execute(sql`DELETE FROM memberships`);
  await getDb().execute(sql`DELETE FROM users`);
  await getDb().execute(sql`DELETE FROM stripe_events`);
  await getDb().execute(sql`DELETE FROM org_subscriptions`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makePastDueOrgWithAdmin(slug: string, failedDaysAgo: number) {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ username: `${slug}-admin`, passwordHash: 'x' })
    .returning();
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role: 'owner' });

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
  return { orgId: org.id, userId: user.id, slug: org.slug };
}

function postEvent(userId: number, slug: string, body: unknown): Parameters<typeof invitesPost>[0] {
  return {
    locals: { user: { id: userId } },
    params: { slug },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
    url: new URL('http://x/'),
  } as unknown as Parameters<typeof invitesPost>[0];
}

describe('POST /api/orgs/[slug]/invites is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('refuses with plan_payment_required once the grace window has elapsed, inviting nobody', async () => {
    const { orgId, userId, slug } = await makePastDueOrgWithAdmin(
      'invite-payment-required-over',
      GRACE_PERIOD_DAYS + 1,
    );

    const res = await invitesPost(postEvent(userId, slug, { email: 'friend@example.com' }));

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('plan_payment_required');

    const invites = await getDb()
      .select()
      .from(schema.orgInvites)
      .where(eq(schema.orgInvites.organizationId, orgId));
    expect(invites).toHaveLength(0);
  });

  it('invites normally while still inside the grace window', async () => {
    const { userId, slug } = await makePastDueOrgWithAdmin('invite-payment-required-grace', 3);

    const res = await invitesPost(postEvent(userId, slug, { email: 'friend@example.com' }));

    expect(res.status).toBe(201);
  });
});
