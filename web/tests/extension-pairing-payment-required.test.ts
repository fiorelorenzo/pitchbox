// #554: "no new devices" for a read-only org - the same enforcement point as
// extension-pairing-plan-limit.test.ts's device ceiling, checked first, with
// its own `plan_payment_required` code. Exercises POST /api/extension/pair
// for the same reason that file does (a dedicated, disposable org - see its
// own header comment on why /auto-pair is inspection-only here).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import { POST as pairConsume } from '../src/routes/api/extension/pair/+server.js';

type ConsumeEvent = Parameters<typeof pairConsume>[0];
const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE extension_devices, extension_pairings RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM stripe_events`);
  await getDb().execute(sql`DELETE FROM org_subscriptions`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makePastDueOrg(slug: string, failedDaysAgo: number) {
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
  return org;
}

async function insertPairing(organizationId: number, code: string) {
  await getDb()
    .insert(schema.extensionPairings)
    .values({ code, organizationId, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
}

function consumeEvent(code: string, ip: string): ConsumeEvent {
  return {
    request: new Request('http://x/api/extension/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
    getClientAddress: () => ip,
  } as unknown as ConsumeEvent;
}

describe('POST /api/extension/pair is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it("refuses redemption once the code's org grace window has elapsed, minting no device", async () => {
    const org = await makePastDueOrg('pairing-payment-required-over', GRACE_PERIOD_DAYS + 1);
    await insertPairing(org.id, 'CODE-PAY-OVER-0001');

    const res = await pairConsume(consumeEvent('CODE-PAY-OVER-0001', '198.51.100.10'));

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('plan_payment_required');

    const devices = await getDb()
      .select()
      .from(schema.extensionDevices)
      .where(eq(schema.extensionDevices.organizationId, org.id));
    expect(devices).toHaveLength(0);
  });

  it('redeems the code normally while still inside the grace window', async () => {
    const org = await makePastDueOrg('pairing-payment-required-grace', 3);
    await insertPairing(org.id, 'CODE-PAY-GRACE-0001');

    const res = await pairConsume(consumeEvent('CODE-PAY-GRACE-0001', '198.51.100.11'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBeTruthy();
  });
});
