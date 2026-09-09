// #550 (a Stripe customer per org, a Checkout session per plan) and #552
// (the customer portal). The customer race and the "no price"/"no customer"
// refusals are exercised against a fake StripeClient, so this file needs no
// credential and runs anywhere.
//
// Starting a **real** Checkout or portal session is the only way to know the
// payload this module sends is one Stripe accepts, and that check now lives in
// `scripts/stripe-probe.ts` (`pnpm run stripe:probe`) rather than here. It used
// to be two tests reading `~/.config/pitchbox-stripe-test.key`, which passes on
// the machine holding the key and fails on a runner: it turned `main` red on
// 2026-09-09 while every PR was green, because the PR path skips this suite.
// The Managed Payments constraints those probes exercise are recorded in
// docs/billing.md.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { ensureStripeCustomer } from '../src/billing/customer.js';
import { createCheckoutSession, UnknownPriceError } from '../src/billing/checkout.js';
import { createPortalSession, NoStripeCustomerError } from '../src/billing/portal.js';
import type { StripeClient, StripeCustomer } from '../src/stripe/client.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function makeOrg(): Promise<number> {
  const db = getDb();
  const slug = `billing-checkout-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

function notImplementedStripeClient(): StripeClient {
  const fail = (method: string) => () => {
    throw new Error(`stub StripeClient.${method} should not have been called`);
  };
  return {
    createCustomer: fail('createCustomer'),
    getCustomer: fail('getCustomer'),
    createCheckoutSession: fail('createCheckoutSession'),
    createPortalSession: fail('createPortalSession'),
    getProduct: fail('getProduct'),
    getPriceByLookupKey: fail('getPriceByLookupKey'),
    getSubscription: fail('getSubscription'),
  };
}

function fakeCustomerCreator(idsToReturn: string[]): StripeClient {
  let call = 0;
  return {
    ...notImplementedStripeClient(),
    async createCustomer(): Promise<StripeCustomer> {
      const id = idsToReturn[call] ?? idsToReturn[idsToReturn.length - 1];
      call += 1;
      return { id, email: null, metadata: {} };
    },
  };
}

describe('ensureStripeCustomer', () => {
  it('creates one customer on first call and reuses it without calling Stripe again', async () => {
    const db = getDb();
    const orgId = await makeOrg();
    const first = await ensureStripeCustomer(db, fakeCustomerCreator(['cus_first']), orgId);
    expect(first).toBe('cus_first');

    // A stub whose createCustomer throws: reuse must never reach it.
    const second = await ensureStripeCustomer(db, notImplementedStripeClient(), orgId);
    expect(second).toBe('cus_first');

    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    expect(org.stripeCustomerId).toBe('cus_first');
  });

  it('two concurrent first calls converge on one winning customer id', async () => {
    const db = getDb();
    const orgId = await makeOrg();
    const [a, b] = await Promise.all([
      ensureStripeCustomer(db, fakeCustomerCreator(['cus_a']), orgId),
      ensureStripeCustomer(db, fakeCustomerCreator(['cus_b']), orgId),
    ]);
    expect(a).toBe(b);
    expect(['cus_a', 'cus_b']).toContain(a);

    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    expect(org.stripeCustomerId).toBe(a);
  });
});

describe('createCheckoutSession', () => {
  it('refuses a plan with no Stripe price rather than calling Stripe', async () => {
    const db = getDb();
    const orgId = await makeOrg();
    await expect(
      createCheckoutSession(db, notImplementedStripeClient(), {
        orgId,
        planId: 'free',
        interval: 'month',
        successUrl: 'https://example.test/settings/billing?checkout=success',
        cancelUrl: 'https://example.test/settings/billing?checkout=cancelled',
      }),
    ).rejects.toBeInstanceOf(UnknownPriceError);
  });

});

describe('createPortalSession', () => {
  it('refuses an org with no Stripe customer rather than calling Stripe', async () => {
    const db = getDb();
    const orgId = await makeOrg();
    await expect(
      createPortalSession(db, notImplementedStripeClient(), {
        orgId,
        returnUrl: 'https://example.test/settings/billing',
        portalConfiguration: null,
      }),
    ).rejects.toBeInstanceOf(NoStripeCustomerError);
  });

});
