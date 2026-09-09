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
 *   - the recorded catalogue in shared/tests/fixtures/stripe/catalogue.json
 *     still matches the account, which is what keeps the hermetic mapping test
 *     honest.
 *
 * Run it before a billing release, and after any change to the price
 * catalogue: `pnpm run stripe:probe`. Nothing here writes to the app database.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStripeClient } from '../shared/src/stripe/client.js';

const KEY_PATH = join(homedir(), '.config/pitchbox-stripe-test.key');
const FIXTURE = join(import.meta.dirname, '../shared/tests/fixtures/stripe/catalogue.json');
const LOOKUPS = [
  'pitchbox_solo_monthly',
  'pitchbox_growth_monthly',
  'pitchbox_growth_yearly',
  'pitchbox_scale_monthly',
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

if (refresh) {
  writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`rewrote ${FIXTURE}`);
} else if (drift > 0) {
  console.error(
    `\n${drift} difference(s) between the account and the recording. Re-run with --refresh once you are sure the account is right.`,
  );
  process.exit(1);
}
