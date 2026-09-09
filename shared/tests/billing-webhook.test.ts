// The Stripe webhook is the only writer of subscription state (#551).
// These exercise the state machine directly - applyStripeEvent - against a
// fake StripeClient standing in for the network, since the signature check
// itself lives at the route layer (web/tests covers that).
//
// The metadata-mapping test asserts against `fixtures/stripe/catalogue.json`,
// which is a **recording of the real test-mode account**, refreshed on purpose
// with `pnpm run stripe:record`. It used to read the account live, which meant
// it also read `~/.config/pitchbox-stripe-test.key`: that passes on the
// machine that holds the key and fails everywhere else, and it turned `main`
// red on 2026-09-09 with `ENOENT /home/runner/.config/pitchbox-stripe-test.key`
// while every PR was green, because the PR path skips this suite. A test that
// needs a credential the runner cannot have is not a test, it is a local
// script. Same reasoning as the landing's token snapshot (DECISIONS.md D24).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { applyStripeEvent, limitsFromProductMetadata } from '../src/billing/webhook.js';
import { createStripeClient } from '../src/stripe/client.js';
import type { StripeClient, StripeProduct, StripeSubscription } from '../src/stripe/client.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function makeOrg(
  overrides: {
    plan?: string;
    planSource?: string;
    stripeCustomerId?: string;
  } = {},
): Promise<{ id: number; stripeCustomerId: string }> {
  const db = getDb();
  const slug = `billing-webhook-test-${randomUUID()}`;
  const stripeCustomerId = overrides.stripeCustomerId ?? `cus_test_${randomUUID()}`;
  const [org] = await db
    .insert(schema.organizations)
    .values({
      slug,
      name: slug,
      stripeCustomerId,
      ...(overrides.plan ? { plan: overrides.plan } : {}),
      ...(overrides.planSource ? { planSource: overrides.planSource } : {}),
    })
    .returning();
  createdOrgIds.push(org.id);
  return { id: org.id, stripeCustomerId };
}

const GROWTH_PRODUCT: StripeProduct = {
  id: 'prod_test_growth',
  metadata: {
    plan: 'growth',
    limit_runs: '2000',
    limit_suggestions: '2000',
    limit_projects: '10',
    limit_seats: '3',
    limit_devices: '10',
    limit_concurrency: '4',
    limit_budget_usd: '30',
    limit_retention_days: '90',
    limit_premium_models: 'true',
  },
};

/** Builds a subscription object shaped like a real `2025-03-31.basil`
 * response (`current_period_start`/`_end` on the item, not the top-level
 * object - see shared/src/billing/webhook.ts's comment on why). */
function fakeSubscription(overrides: {
  id: string;
  customer: string;
  status?: StripeSubscription['status'];
  cancelAtPeriodEnd?: boolean;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  product?: StripeProduct;
}): StripeSubscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: overrides.id,
    customer: overrides.customer,
    status: overrides.status ?? 'active',
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    metadata: {},
    items: {
      data: [
        {
          id: `si_${overrides.id}`,
          price: {
            id: `price_test_${overrides.id}`,
            lookup_key: 'pitchbox_growth_monthly',
            product: overrides.product ?? GROWTH_PRODUCT,
          },
          current_period_start: overrides.currentPeriodStart ?? now,
          current_period_end: overrides.currentPeriodEnd ?? now + 30 * 24 * 60 * 60,
        },
      ],
    },
  };
}

/** A `StripeClient` whose `getSubscription` is fully controlled by the
 * test; every other method throws if a test reaches it, since none of the
 * webhook scenarios below call anything else. */
function fakeStripeClient(subscriptions: Record<string, StripeSubscription>): StripeClient {
  const notImplemented = (method: string) => () => {
    throw new Error(`fakeStripeClient.${method} was not stubbed for this test`);
  };
  return {
    createCustomer: notImplemented('createCustomer'),
    getCustomer: notImplemented('getCustomer'),
    createCheckoutSession: notImplemented('createCheckoutSession'),
    createPortalSession: notImplemented('createPortalSession'),
    getProduct: notImplemented('getProduct'),
    getPriceByLookupKey: notImplemented('getPriceByLookupKey'),
    async getSubscription(id: string) {
      const sub = subscriptions[id];
      if (!sub) throw new Error(`fakeStripeClient has no subscription stubbed for ${id}`);
      return sub;
    },
  };
}

describe('applyStripeEvent', () => {
  it('checkout.session.completed derives the plan from the subscription product metadata', async () => {
    const org = await makeOrg();
    const sub = fakeSubscription({ id: `sub_${randomUUID()}`, customer: org.stripeCustomerId });
    const stripe = fakeStripeClient({ [sub.id]: sub });

    const result = await applyStripeEvent(getDb(), stripe, {
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { subscription: sub.id, customer: org.stripeCustomerId } },
    });
    expect(result.outcome).toBe('applied');

    const [row] = await getDb()
      .select()
      .from(schema.orgSubscriptions)
      .where(eq(schema.orgSubscriptions.organizationId, org.id));
    expect(row.planId).toBe('growth');
    expect(row.limitRuns).toBe(2000);
    expect(row.limitDevices).toBe(10);
    expect(row.status).toBe('active');

    const [freshOrg] = await getDb()
      .select({ plan: schema.organizations.plan, planSource: schema.organizations.planSource })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
    expect(freshOrg.plan).toBe('growth');
    expect(freshOrg.planSource).toBe('stripe');
  });

  it('a replayed delivery leaves one row, not two', async () => {
    const org = await makeOrg();
    const sub = fakeSubscription({ id: `sub_${randomUUID()}`, customer: org.stripeCustomerId });
    const stripe = fakeStripeClient({ [sub.id]: sub });
    const event = {
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.updated' as const,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sub.id, customer: org.stripeCustomerId } },
    };

    const first = await applyStripeEvent(getDb(), stripe, event);
    expect(first.outcome).toBe('applied');
    const second = await applyStripeEvent(getDb(), stripe, event);
    expect(second.outcome).toBe('duplicate');

    const rows = await getDb()
      .select()
      .from(schema.orgSubscriptions)
      .where(eq(schema.orgSubscriptions.organizationId, org.id));
    expect(rows).toHaveLength(1);
    const eventRows = await getDb()
      .select()
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, event.id));
    expect(eventRows).toHaveLength(1);
  });

  it('an out-of-order update does not move current_period_end backwards', async () => {
    const org = await makeOrg();
    const subscriptionId = `sub_${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const later = fakeSubscription({
      id: subscriptionId,
      customer: org.stripeCustomerId,
      currentPeriodEnd: now + 60 * 24 * 60 * 60,
    });
    const earlier = fakeSubscription({
      id: subscriptionId,
      customer: org.stripeCustomerId,
      currentPeriodEnd: now + 10 * 24 * 60 * 60,
      status: 'past_due',
    });

    const first = await applyStripeEvent(getDb(), fakeStripeClient({ [subscriptionId]: later }), {
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.updated',
      created: now,
      data: { object: { id: subscriptionId, customer: org.stripeCustomerId } },
    });
    expect(first.outcome).toBe('applied');

    const second = await applyStripeEvent(
      getDb(),
      fakeStripeClient({ [subscriptionId]: earlier }),
      {
        id: `evt_${randomUUID()}`,
        type: 'customer.subscription.updated',
        created: now - 1,
        data: { object: { id: subscriptionId, customer: org.stripeCustomerId } },
      },
    );
    expect(second.outcome).toBe('stale');

    const [row] = await getDb()
      .select()
      .from(schema.orgSubscriptions)
      .where(eq(schema.orgSubscriptions.organizationId, org.id));
    // The stale (earlier) event's status never overwrote the later one's.
    expect(row.status).toBe('active');
    expect(row.currentPeriodEnd.getTime()).toBe(later.items.data[0].current_period_end * 1000);
  });

  it('an event for an unknown customer is recorded and skipped rather than throwing', async () => {
    const stranger = `cus_${randomUUID()}`;
    const sub = fakeSubscription({ id: `sub_${randomUUID()}`, customer: stranger });
    const stripe = fakeStripeClient({ [sub.id]: sub });
    const eventId = `evt_${randomUUID()}`;

    await expect(
      applyStripeEvent(getDb(), stripe, {
        id: eventId,
        type: 'customer.subscription.updated',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: sub.id, customer: stranger } },
      }),
    ).resolves.toEqual({ outcome: 'unknown-customer', detail: stranger });

    const [row] = await getDb()
      .select()
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, eventId));
    expect(row).toBeDefined();
    expect(row.processedAt).not.toBeNull();
  });

  it('a subscription deletion drops the org to free with its other data intact', async () => {
    const org = await makeOrg({ plan: 'growth', planSource: 'stripe' });
    const sub = fakeSubscription({ id: `sub_${randomUUID()}`, customer: org.stripeCustomerId });
    // Seed the row the deletion is expected to remove.
    await applyStripeEvent(getDb(), fakeStripeClient({ [sub.id]: sub }), {
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sub.id, customer: org.stripeCustomerId } },
    });

    const result = await applyStripeEvent(getDb(), fakeStripeClient({}), {
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sub.id, customer: org.stripeCustomerId } },
    });
    expect(result.outcome).toBe('applied');

    const [freshOrg] = await getDb()
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
    expect(freshOrg.plan).toBe('free');
    expect(freshOrg.planSource).toBe('stripe');
    expect(freshOrg.stripeCustomerId).toBe(org.stripeCustomerId); // data intact
    expect(freshOrg.slug).toContain('billing-webhook-test');

    const rows = await getDb()
      .select()
      .from(schema.orgSubscriptions)
      .where(eq(schema.orgSubscriptions.organizationId, org.id));
    expect(rows).toHaveLength(0);
  });

  it('a grant survives a deletion event', async () => {
    const org = await makeOrg({ plan: 'scale', planSource: 'grant' });
    const sub = fakeSubscription({ id: `sub_${randomUUID()}`, customer: org.stripeCustomerId });

    const result = await applyStripeEvent(getDb(), fakeStripeClient({}), {
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sub.id, customer: org.stripeCustomerId } },
    });
    expect(result.outcome).toBe('applied');
    expect(result.detail).toBe('grant preserved');

    const [freshOrg] = await getDb()
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
    expect(freshOrg.plan).toBe('scale');
    expect(freshOrg.planSource).toBe('grant');
  });

  it("maps the real Stripe product's recorded metadata (growth) to org_subscriptions limits", async () => {
    const catalogue = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/stripe/catalogue.json'), 'utf8'),
    ) as Record<string, { price: { unit_amount: number }; product: { metadata: Record<string, string> } }>;
    const recorded = catalogue.pitchbox_growth_monthly;
    // The recording is what the account really answers, so this still proves
    // the mapping against Stripe's own shape and its string-typed metadata,
    // rather than against a hand-written object that agrees with the code.
    expect(recorded.price.unit_amount).toBe(7900);
    expect(recorded.product.metadata.plan).toBe('growth');

    const limits = limitsFromProductMetadata(recorded.product.metadata);
    expect(limits).toEqual({
      planId: 'growth',
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
  });
});
