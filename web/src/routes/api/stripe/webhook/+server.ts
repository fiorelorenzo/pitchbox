// The Stripe webhook is the only writer of subscription state (#551).
// Exempt from the auth hook and CSRF (web/src/hooks.server.ts) - Stripe
// signs the request itself, and this route verifies that signature against
// the raw body before it is read any other way.
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { loadStripeEnv } from '@pitchbox/shared/stripe/env';
import {
  createStripeClient,
  InvalidStripeEventError,
  parseStripeEvent,
} from '@pitchbox/shared/stripe/client';
import { verifyStripeSignature } from '@pitchbox/shared/stripe/signature';
import { applyStripeEvent } from '@pitchbox/shared/billing/webhook';

export async function POST(event: RequestEvent) {
  const stripeEnv = loadStripeEnv();
  if (!stripeEnv.enabled || !stripeEnv.webhookSecret) throw error(404, 'billing_disabled');

  // The raw bytes, not `request.json()`: the signature is computed over the
  // exact body Stripe sent, and reading it as JSON first would both parse
  // before verifying and risk losing byte-for-byte fidelity to whitespace/
  // key order that a re-serialization does not preserve.
  const rawBody = await event.request.text();
  const signatureHeader = event.request.headers.get('stripe-signature');
  if (!verifyStripeSignature(rawBody, signatureHeader, stripeEnv.webhookSecret)) {
    throw error(400, 'invalid_signature');
  }

  let stripeEvent;
  try {
    stripeEvent = parseStripeEvent(rawBody);
  } catch (err) {
    if (err instanceof InvalidStripeEventError) throw error(400, 'invalid_event');
    throw err;
  }

  const db = getDb();
  const stripe = createStripeClient(stripeEnv.secretKey);
  const result = await applyStripeEvent(db, stripe, stripeEvent);
  return json({ received: true, outcome: result.outcome });
}
