// #550/#552: the checkout and portal routes' own guards - disabled when
// billing is off, admin-or-owner only, and the specific refusals that must
// answer with a clean 4xx rather than a 500 (no Stripe price for a plan
// with none, no Stripe customer yet on the free plan). None of these paths
// reach the real Stripe network: the plan/role/customer checks all run
// before this route would ever call it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as checkoutPost } from '../src/routes/api/billing/checkout/+server.js';
import { POST as portalPost } from '../src/routes/api/billing/portal/+server.js';

const savedEnv: Record<string, string | undefined> = {};

function withEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function billingOn() {
  withEnv({ PITCHBOX_BILLING: 'on', STRIPE_SECRET_KEY: 'sk_test_dummy' });
}

function checkoutEvent(locals: Record<string, unknown>, body: unknown): RequestEvent {
  return {
    locals,
    url: new URL('https://app.pitchbox.app/api/billing/checkout'),
    request: new Request('https://app.pitchbox.app/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as RequestEvent;
}

function portalEvent(locals: Record<string, unknown>): RequestEvent {
  return {
    locals,
    url: new URL('https://app.pitchbox.app/api/billing/portal'),
    request: new Request('https://app.pitchbox.app/api/billing/portal', { method: 'POST' }),
  } as unknown as RequestEvent;
}

let orgId: number;

beforeAll(async () => {
  const [org] = await getDb()
    .insert(schema.organizations)
    .values({ slug: `billing-gating-test-${Date.now()}`, name: 'billing-gating-test' })
    .returning();
  orgId = org.id;
});

afterAll(async () => {
  await getDb().delete(schema.organizations).where(eq(schema.organizations.id, orgId));
});

function adminLocals() {
  return { org: { id: orgId, slug: 'x', role: 'admin' } };
}
function memberLocals() {
  return { org: { id: orgId, slug: 'x', role: 'member' } };
}

describe('POST /api/billing/checkout', () => {
  it('404s when billing is disabled', async () => {
    withEnv({ PITCHBOX_BILLING: undefined, STRIPE_SECRET_KEY: undefined });
    await expect(
      checkoutPost(checkoutEvent(adminLocals(), { plan: 'growth', interval: 'month' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a member (admin or owner only)', async () => {
    billingOn();
    await expect(
      checkoutPost(checkoutEvent(memberLocals(), { plan: 'growth', interval: 'month' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a malformed body for an admin before ever reaching Stripe', async () => {
    billingOn();
    const res = await checkoutPost(
      checkoutEvent(adminLocals(), { plan: 'not-a-real-plan', interval: 'month' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('rejects a request naming a price id instead of a plan/interval', async () => {
    billingOn();
    const res = await checkoutPost(
      checkoutEvent(adminLocals(), { priceId: 'price_attacker_supplied', plan: 'growth' }),
    );
    // `interval` is still missing - the schema has no field for a raw
    // price id at all, so supplying one is simply ignored input, and the
    // body is invalid regardless.
    expect(res.status).toBe(400);
  });
});

describe('POST /api/billing/portal', () => {
  it('404s when billing is disabled', async () => {
    withEnv({ PITCHBOX_BILLING: undefined, STRIPE_SECRET_KEY: undefined });
    await expect(portalPost(portalEvent(adminLocals()))).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a member (admin or owner only)', async () => {
    billingOn();
    await expect(portalPost(portalEvent(memberLocals()))).rejects.toMatchObject({ status: 403 });
  });

  it('answers 400 no_customer for an org with no Stripe customer yet, not a 500', async () => {
    billingOn();
    // The org created in beforeAll has no `stripe_customer_id` set - the
    // free-plan case docs/billing.md #552 describes ("the button offers
    // checkout instead").
    const res = await portalPost(portalEvent(adminLocals()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_customer');
  });
});
