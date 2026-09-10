#!/usr/bin/env tsx
/**
 * The live half of the billing verification, deliberately not a test (#550,
 * #551, #552). It talks to the real **test-mode** Stripe account, so it needs
 * `~/.config/pitchbox-stripe-test.key` and cannot run on a CI runner: a check
 * that needs a credential the runner has no way to hold is a script, and
 * leaving it in the suite is what turned `main` red on 2026-09-09 while every
 * PR was green, since the PR path skips `Tests (Postgres)`.
 *
 * What it proves, and what no fixture can:
 *   - the Checkout payload this repo sends is one Stripe accepts under Managed
 *     Payments, including that the parameters it must not send are absent;
 *   - the portal session opens for a customer this repo created;
 *   - the portal configuration still defers a downgrade to period end, which
 *     is a property of an object in Stripe and cannot be asserted from here
 *     any other way (#613);
 *   - the recorded catalogue in shared/tests/fixtures/stripe/catalogue.json
 *     still matches the account, which is what keeps the hermetic mapping test
 *     honest;
 *   - the account holds no *enabled* webhook endpoint for the other mode's
 *     deployment (LOR-156) - that endpoint can never verify a signature here,
 *     and `scripts/stripe-setup.ts` only disables it on the run that notices,
 *     never automatically;
 *   - the LOR-188 live-verification coupon and its promotion code are still
 *     present with the restrictions that keep them from leaking into a real
 *     sale (100% off, single redemption, an expiry) - all four of those are
 *     immutable in Stripe once created, so a wrong value here means the
 *     object has to be deleted and re-created, not patched.
 *
 * Run it before a billing release, and after any change to the price
 * catalogue: `pnpm run stripe:probe`. Nothing here writes to the app database.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStripeClient } from '../shared/src/stripe/client.js';
import {
  LIVE_VERIFICATION_COUPON_ID,
  LIVE_VERIFICATION_MAX_REDEMPTIONS,
  LIVE_VERIFICATION_PROMOTION_CODE,
} from '../shared/src/stripe/live-verification-coupon.js';
import {
  endpointBelongsToMode,
  stripeModeFromKey,
  webhookEndpointTargets,
} from '../shared/src/stripe/webhook-endpoints.js';

const APP_ORIGIN = process.env.PITCHBOX_APP_ORIGIN ?? 'https://app.pitchbox.app';
const PREVIEW_ORIGIN = process.env.PITCHBOX_PREVIEW_ORIGIN ?? 'https://preview.pitchbox.app';

const KEY_PATH = join(homedir(), '.config/pitchbox-stripe-test.key');
const FIXTURE = join(import.meta.dirname, '../shared/tests/fixtures/stripe/catalogue.json');
// All six prices, not a sample: every one of them is a price a customer can be
// sold, so a drifted amount or a missing lookup key on any of them is a real
// defect, and the two yearly ones were exactly the pair nothing looked at.
const LOOKUPS = [
  'pitchbox_solo_monthly',
  'pitchbox_solo_yearly',
  'pitchbox_growth_monthly',
  'pitchbox_growth_yearly',
  'pitchbox_scale_monthly',
  'pitchbox_scale_yearly',
];

function readKey(): string {
  try {
    return readFileSync(KEY_PATH, 'utf8').trim();
  } catch {
    console.error(
      `no Stripe test key at ${KEY_PATH}. This script is for the machine that holds it; CI is not.`,
    );
    process.exit(2);
  }
}

const refresh = process.argv.includes('--refresh');
const stripe = createStripeClient(readKey());

const recorded: Record<string, unknown> = {};
let drift = 0;
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<
  string,
  { price: { unit_amount: number }; product: { metadata: Record<string, string> } }
>;

for (const lookup of LOOKUPS) {
  const price = await stripe.getPriceByLookupKey(lookup);
  if (!price) {
    console.error(`missing price for lookup key ${lookup}`);
    drift += 1;
    continue;
  }
  const productId = typeof price.product === 'string' ? price.product : price.product.id;
  const product = await stripe.getProduct(productId);
  recorded[lookup] = {
    price: {
      id: price.id,
      lookup_key: price.lookup_key,
      unit_amount: price.unit_amount,
      currency: price.currency,
      recurring: price.recurring,
    },
    product: { id: product.id, name: product.name, metadata: product.metadata },
  };

  const known = fixture[lookup];
  if (!known) {
    console.log(`${lookup}: not in the recording`);
    drift += 1;
  } else if (known.price.unit_amount !== price.unit_amount) {
    console.log(
      `${lookup}: amount drifted, recorded ${known.price.unit_amount}, account ${price.unit_amount}`,
    );
    drift += 1;
  } else if (JSON.stringify(known.product.metadata) !== JSON.stringify(product.metadata)) {
    console.log(`${lookup}: product metadata drifted`);
    drift += 1;
  } else {
    console.log(`${lookup}: ok (${price.unit_amount} ${price.currency})`);
  }
}

// LOR-188: the 100%-off coupon docs/billing.md names for exercising the live
// billing path without a real charge. scripts/stripe-setup.ts creates it;
// this only ever reads it back, the same as the portal configuration below -
// percent_off, duration, max_redemptions and the expiry are all immutable
// once the coupon or its promotion code exist, so a wrong value here means
// delete-and-rerun, not something this probe could ever fix.
type Coupon = {
  id: string;
  valid: boolean;
  percent_off: number | null;
  duration: string;
  max_redemptions: number | null;
  redeem_by: number | null;
};
type PromotionCode = {
  id: string;
  code: string;
  active: boolean;
  max_redemptions: number | null;
  coupon: { id: string };
};

const couponResponse = await fetch(
  `https://api.stripe.com/v1/coupons/${LIVE_VERIFICATION_COUPON_ID}`,
  { headers: { Authorization: `Bearer ${readKey()}`, 'Stripe-Version': '2025-03-31.basil' } },
);
if (!couponResponse.ok) {
  console.log(`coupon ${LIVE_VERIFICATION_COUPON_ID}: not on the account (run stripe-setup.ts)`);
  drift += 1;
} else {
  const coupon = (await couponResponse.json()) as Coupon;
  const issues: string[] = [];
  if (coupon.percent_off !== 100) issues.push(`percent_off=${coupon.percent_off}`);
  if (coupon.max_redemptions !== LIVE_VERIFICATION_MAX_REDEMPTIONS) {
    issues.push(`max_redemptions=${coupon.max_redemptions}`);
  }
  if (!coupon.redeem_by) issues.push('no expiry (redeem_by)');
  if (!coupon.valid) issues.push('no longer valid (expired or exhausted)');
  if (issues.length > 0) {
    console.log(`coupon ${coupon.id}: ${issues.join(', ')}`);
    drift += 1;
  } else {
    console.log(
      `coupon ${coupon.id}: ok (100% off, ${coupon.duration}, max_redemptions=${coupon.max_redemptions}, expires ${new Date(coupon.redeem_by! * 1000).toISOString().slice(0, 10)})`,
    );
  }

  const promoResponse = await fetch(
    `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(LIVE_VERIFICATION_PROMOTION_CODE)}&limit=1`,
    { headers: { Authorization: `Bearer ${readKey()}`, 'Stripe-Version': '2025-03-31.basil' } },
  );
  const promoList = (await promoResponse.json()) as { data: PromotionCode[] };
  const promo = promoList.data[0];
  if (!promo) {
    console.log(
      `promotion code ${LIVE_VERIFICATION_PROMOTION_CODE}: not on the account (run stripe-setup.ts)`,
    );
    drift += 1;
  } else {
    const promoIssues: string[] = [];
    if (promo.coupon.id !== coupon.id) {
      promoIssues.push(`points at coupon ${promo.coupon.id}, not ${coupon.id}`);
    }
    if (!promo.active) promoIssues.push('inactive');
    if (promo.max_redemptions !== LIVE_VERIFICATION_MAX_REDEMPTIONS) {
      promoIssues.push(`max_redemptions=${promo.max_redemptions}`);
    }
    if (promoIssues.length > 0) {
      console.log(`promotion code ${promo.code}: ${promoIssues.join(', ')}`);
      drift += 1;
    } else {
      console.log(`promotion code ${promo.code}: ok -> coupon ${coupon.id}`);
    }
  }
}

// The portal configuration is what defers a downgrade to period end (#613), and
// nothing in the app can assert it: the app only ever passes a configuration id
// to `billing_portal/sessions`, and the behaviour lives in the object that id
// names. A configuration whose `schedule_at_period_end` conditions went missing
// applies a cheaper price immediately, taking value from a customer who did
// nothing wrong, and it looks identical from this repo. So read it back here.
//
// Only the conditions can be checked this way. `subscription_update.products`,
// which is what decides that all six prices are switchable, is accepted on
// write and then **not returned** on read (measured 2026-09-10: the object
// comes back with `enabled`, `default_allowed_updates`, `proration_behavior`,
// `schedule_at_period_end`, `billing_cycle_anchor` and
// `trial_update_behavior`, and nothing else). Reading it back proves nothing
// about the price list, so this does not pretend to: that half is verified by
// opening a portal session for a subscribed customer and looking at the page.
const REQUIRED_CONDITIONS = ['decreasing_item_amount', 'shortening_interval'];

type PortalConfiguration = {
  id: string;
  is_default: boolean;
  metadata: Record<string, string>;
  features: {
    subscription_update: {
      enabled: boolean;
      schedule_at_period_end?: { conditions: { type: string }[] };
    };
  };
};

const portalResponse = await fetch(
  'https://api.stripe.com/v1/billing_portal/configurations?limit=100',
  { headers: { Authorization: `Bearer ${readKey()}`, 'Stripe-Version': '2025-03-31.basil' } },
);
const portalList = (await portalResponse.json()) as { data: PortalConfiguration[] };
const portal =
  portalList.data.find((c) => c.metadata?.pitchbox === 'portal') ??
  portalList.data.find((c) => c.is_default);

if (!portal) {
  console.log('portal: no configuration on the account');
  drift += 1;
} else {
  const update = portal.features.subscription_update;
  const conditions = (update.schedule_at_period_end?.conditions ?? []).map((c) => c.type);
  const missing = REQUIRED_CONDITIONS.filter((c) => !conditions.includes(c));
  if (!update.enabled) {
    console.log(`portal ${portal.id}: subscription_update is disabled, no plan switching at all`);
    drift += 1;
  } else if (missing.length > 0) {
    console.log(
      `portal ${portal.id}: a downgrade applies IMMEDIATELY - missing schedule_at_period_end condition(s) ${missing.join(', ')}`,
    );
    drift += 1;
  } else {
    console.log(`portal ${portal.id}: ok (defers on ${conditions.join(', ')})`);
  }
}

// LOR-156: this key's mode should hold exactly its own webhook endpoint,
// never the other deployment's - a real event posted to the wrong-mode
// endpoint gets a 400 invalid_signature and retries until Stripe disables
// it, and nothing in this repo would notice until that happens.
const mode = stripeModeFromKey(readKey());
const origins = { app: APP_ORIGIN, preview: PREVIEW_ORIGIN };
const knownTargets = webhookEndpointTargets(origins);
const webhookResponse = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
  headers: { Authorization: `Bearer ${readKey()}`, 'Stripe-Version': '2025-03-31.basil' },
});
const webhookList = (await webhookResponse.json()) as {
  data: { id: string; url: string; status: string }[];
};
const mismatched = webhookList.data.find(
  (w) =>
    w.status === 'enabled' &&
    knownTargets.some((t) => t.url === w.url) &&
    !endpointBelongsToMode(w.url, mode, origins),
);
if (mismatched) {
  const wrongTarget = knownTargets.find((t) => t.url === mismatched.url)!;
  console.log(
    `webhook ${mismatched.id}: ${mismatched.url} is the ${wrongTarget.label} endpoint (${wrongTarget.mode} mode), but this key is ${mode} mode - disable it (a stripe-setup.ts run in ${mode} mode does this)`,
  );
  drift += 1;
} else {
  console.log(`webhook: no enabled endpoint for the other mode visible to this ${mode}-mode key`);
}

if (refresh) {
  writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`rewrote ${FIXTURE}`);
} else if (drift > 0) {
  console.error(
    `\n${drift} difference(s) between the account and the recording. Re-run with --refresh once you are sure the account is right.`,
  );
  process.exit(1);
}
