// A Stripe customer per org, and a Checkout session per plan (#550). This
// route never writes a plan - the webhook (`/api/stripe/webhook`, #551) is
// the only writer, and this route's own job ends the moment it hands back a
// session URL.
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { loadStripeEnv } from '@pitchbox/shared/stripe/env';
import { createStripeClient } from '@pitchbox/shared/stripe/client';
import { createCheckoutSession, UnknownPriceError } from '@pitchbox/shared/billing/checkout';
import { PLAN_IDS } from '@pitchbox/shared/plans';

const Body = z.object({
  plan: z.enum(PLAN_IDS),
  interval: z.enum(['month', 'year']),
});

export async function POST(event: RequestEvent) {
  const stripeEnv = loadStripeEnv();
  // Same posture `/api/auth/*` takes when auth is off (docs #550): billing
  // off, or self-host with no Stripe key, means this route does not exist.
  if (!stripeEnv.enabled) throw error(404, 'billing_disabled');

  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const db = getDb();
  const stripe = createStripeClient(stripeEnv.secretKey);
  try {
    const session = await createCheckoutSession(db, stripe, {
      orgId,
      planId: parsed.data.plan,
      interval: parsed.data.interval,
      successUrl: `${event.url.origin}/settings/billing?checkout=success`,
      cancelUrl: `${event.url.origin}/settings/billing?checkout=cancelled`,
    });
    return json(session);
  } catch (err) {
    // Free has no Stripe price, and a lookup key resolving nothing is a
    // catalogue drift between this deployment and its Stripe account -
    // both are the caller's problem, not a 500.
    if (err instanceof UnknownPriceError) {
      return json({ error: 'unknown_price' }, { status: 400 });
    }
    throw err;
  }
}
