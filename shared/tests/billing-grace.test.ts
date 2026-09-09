// #554: the grace window's own timing logic, isolated from the webhook that
// drives it. `pastDueSince` reads `stripe_events` (the webhook's own
// idempotency ledger) directly, so these tests write rows into it exactly
// the shape `applyStripeEvent` would have left, rather than replaying a
// whole webhook delivery for a question that is really about one query.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { GRACE_PERIOD_DAYS, graceEndsAt, pastDueSince } from '../src/billing/grace.js';
import { isOrgReadOnly, type Entitlements } from '../src/plans.js';

const insertedEventIds: string[] = [];

afterEach(async () => {
  const db = getDb();
  while (insertedEventIds.length > 0) {
    const id = insertedEventIds.pop()!;
    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, id));
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function recordEvent(
  type: 'invoice.payment_failed' | 'invoice.paid',
  subscriptionId: string,
  receivedAt: Date,
): Promise<void> {
  const id = `evt_${randomUUID()}`;
  const db = getDb();
  await db.insert(schema.stripeEvents).values({
    id,
    type,
    receivedAt,
    processedAt: receivedAt,
    payload: {
      id,
      type,
      created: Math.floor(receivedAt.getTime() / 1000),
      data: { object: { subscription: subscriptionId, customer: `cus_${subscriptionId}` } },
    },
  });
  insertedEventIds.push(id);
}

describe('pastDueSince', () => {
  it('is null when the subscription has never recorded a failed invoice', async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    await recordEvent('invoice.paid', subscriptionId, new Date());
    expect(await pastDueSince(getDb(), subscriptionId)).toBeNull();
  });

  it('anchors on the first failure, not a later Smart Retries reattempt', async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const firstFailure = new Date(Date.now() - 10 * DAY_MS);
    const secondFailure = new Date(Date.now() - 2 * DAY_MS);
    await recordEvent('invoice.payment_failed', subscriptionId, firstFailure);
    await recordEvent('invoice.payment_failed', subscriptionId, secondFailure);

    const since = await pastDueSince(getDb(), subscriptionId);
    expect(since?.getTime()).toBe(firstFailure.getTime());
  });

  it('a recovered subscription only sees a failure after its own invoice.paid', async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const oldFailure = new Date(Date.now() - 40 * DAY_MS);
    const recovery = new Date(Date.now() - 20 * DAY_MS);
    const freshFailure = new Date(Date.now() - 1 * DAY_MS);
    await recordEvent('invoice.payment_failed', subscriptionId, oldFailure);
    await recordEvent('invoice.paid', subscriptionId, recovery);
    await recordEvent('invoice.payment_failed', subscriptionId, freshFailure);

    const since = await pastDueSince(getDb(), subscriptionId);
    expect(since?.getTime()).toBe(freshFailure.getTime());
  });

  it("does not see another subscription's failures", async () => {
    const mine = `sub_${randomUUID()}`;
    const theirs = `sub_${randomUUID()}`;
    await recordEvent('invoice.payment_failed', theirs, new Date());
    expect(await pastDueSince(getDb(), mine)).toBeNull();
  });
});

describe('graceEndsAt', () => {
  it('is GRACE_PERIOD_DAYS after the given instant', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    expect(graceEndsAt(since).getTime()).toBe(since.getTime() + GRACE_PERIOD_DAYS * DAY_MS);
  });
});

function entitlementsWithGrace(graceEndsAtValue: Date | null): Entitlements {
  return {
    runsPerMonth: 500,
    suggestionsPerMonth: 500,
    projects: 3,
    seats: 1,
    extensionDevices: 3,
    maxConcurrentRuns: 2,
    monthlyRunBudgetUsd: 10,
    retentionDays: 30,
    premiumModels: false,
    webhooks: false,
    planId: 'solo',
    source: 'subscription',
    graceEndsAt: graceEndsAtValue,
  };
}

describe('isOrgReadOnly', () => {
  it('is false when the entitlements carry no grace deadline at all', () => {
    expect(isOrgReadOnly(entitlementsWithGrace(null))).toBe(false);
  });

  it('is false while still inside the grace window', () => {
    const since = new Date(Date.now() - (GRACE_PERIOD_DAYS - 1) * DAY_MS);
    const entitlements = entitlementsWithGrace(graceEndsAt(since));
    expect(isOrgReadOnly(entitlements)).toBe(false);
  });

  it('flips to true the instant the clock passes the grace deadline - proven by moving the clock, not by waiting', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    const entitlements = entitlementsWithGrace(graceEndsAt(since));
    const oneSecondBefore = new Date(graceEndsAt(since).getTime() - 1000);
    const exactBoundary = graceEndsAt(since);
    const oneSecondAfter = new Date(graceEndsAt(since).getTime() + 1000);
    expect(isOrgReadOnly(entitlements, oneSecondBefore)).toBe(false);
    expect(isOrgReadOnly(entitlements, exactBoundary)).toBe(true);
    expect(isOrgReadOnly(entitlements, oneSecondAfter)).toBe(true);
  });
});
