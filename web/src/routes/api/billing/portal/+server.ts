// The customer portal is where a plan changes and a card is updated (#552).
// Every change made there comes back as a webhook (#551); this route
// writes nothing.
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { loadStripeEnv } from '@pitchbox/shared/stripe/env';
import { createStripeClient } from '@pitchbox/shared/stripe/client';
import { createPortalSession, NoStripeCustomerError } from '@pitchbox/shared/billing/portal';

export async function POST(event: RequestEvent) {
  const stripeEnv = loadStripeEnv();
  if (!stripeEnv.enabled) throw error(404, 'billing_disabled');

  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const db = getDb();
  const stripe = createStripeClient(stripeEnv.secretKey);
  try {
    const session = await createPortalSession(db, stripe, {
      orgId,
      returnUrl: `${event.url.origin}/settings/billing`,
      portalConfiguration: stripeEnv.portalConfiguration,
    });
    return json(session);
  } catch (err) {
    // An org with no Stripe customer yet is the free-plan case (#552): the
    // button offers checkout instead, and that decision belongs to the
    // caller, not a 500 here.
    if (err instanceof NoStripeCustomerError) {
      return json({ error: 'no_customer' }, { status: 400 });
    }
    throw err;
  }
}
