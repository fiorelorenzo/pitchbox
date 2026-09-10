// Create or reconcile the Stripe objects Pitchbox billing depends on: the plan
// catalogue (products + prices), the customer portal configuration, the two
// webhook endpoints, and the Stripe Tax defaults.
//
// This file is the source of truth for the catalogue. The app never hardcodes a
// price id: it resolves prices by `lookup_key` and reads entitlements from the
// product metadata this script writes, so test mode and live mode can be brought
// to the same shape by running it twice with different keys.
//
//   STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/stripe-setup.ts --dry-run
//   STRIPE_SECRET_KEY=sk_live_... pnpm exec tsx scripts/stripe-setup.ts \
//     --secrets-out ~/.config/pitchbox-stripe-live-webhooks.env
//
// It is idempotent: an object that already matches is left alone, a changed
// field is patched, and a price whose amount changed is replaced (the old one is
// deactivated and the lookup key moves to the new one, which is the only way to
// reprice in Stripe since prices are immutable).
//
// Nothing here carries the legal entity: the head office address, the tax
// registrations and the payout account are set once during activation, in the
// dashboard, and are deliberately not repo-facing. `--head-office` reads the
// address from the environment when it has to be set from a script.
import { writeFile } from 'node:fs/promises';

type Money = { eur: number; usd: number };

type Plan = {
  slug: string;
  name: string;
  description: string;
  monthly: Money;
  yearly: Money;
  limits: Record<string, string>;
};

type Metadata = Record<string, string>;

type StripeList<T> = { data: T[] };

type StripeAccount = { id: string; charges_enabled: boolean; payouts_enabled: boolean };

type StripeProduct = {
  id: string;
  name: string;
  description: string | null;
  tax_code: string | null;
  metadata: Metadata;
};

type StripePrice = {
  id: string;
  product: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  lookup_key: string | null;
  tax_behavior: string;
  metadata: Metadata;
  recurring: { interval: string } | null;
  currency_options?: Record<string, { unit_amount: number | null; tax_behavior: string }>;
};

type StripePortalConfiguration = { id: string; is_default: boolean; metadata: Metadata };

type StripeWebhookEndpoint = {
  id: string;
  url: string;
  status: string;
  enabled_events: string[];
  metadata: Metadata;
  secret?: string;
};

type StripeTaxSettings = { status: string };

// SaaS, business use. The same code on every plan; it drives what Stripe Tax
// computes per country.
const TAX_CODE = 'txcd_10103001';

// Amounts are minor units. USD is carried as a `currency_options` entry on the
// same price rather than as a parallel price object, so adding a currency never
// changes an id the app resolves. USD deliberately mirrors the EUR figure
// instead of tracking the exchange rate: same headline number in both.
const PLANS: Plan[] = [
  {
    slug: 'solo',
    name: 'Pitchbox Solo',
    description:
      'For one operator: 3 projects, 500 agent runs and 500 in-page suggestions a month, 5 connected accounts, fast models.',
    monthly: { eur: 2900, usd: 2900 },
    yearly: { eur: 29000, usd: 29000 },
    limits: {
      limit_projects: '3',
      limit_runs: '500',
      limit_suggestions: '500',
      limit_seats: '1',
      limit_devices: '3',
      limit_concurrency: '2',
      limit_budget_usd: '10',
      limit_retention_days: '30',
      limit_premium_models: 'false',
    },
  },
  {
    slug: 'growth',
    name: 'Pitchbox Growth',
    description:
      'For a small team: 10 projects, 2,000 agent runs and 2,000 suggestions a month, 3 seats, premium models, webhooks.',
    monthly: { eur: 7900, usd: 7900 },
    yearly: { eur: 79000, usd: 79000 },
    limits: {
      limit_projects: '10',
      limit_runs: '2000',
      limit_suggestions: '2000',
      limit_seats: '3',
      limit_devices: '10',
      limit_concurrency: '4',
      limit_budget_usd: '30',
      limit_retention_days: '90',
      limit_premium_models: 'true',
    },
  },
  {
    slug: 'scale',
    name: 'Pitchbox Scale',
    description:
      'For an agency: 30 projects, 8,000 agent runs and 8,000 suggestions a month, 10 seats, premium models, 180-day retention.',
    monthly: { eur: 19900, usd: 19900 },
    yearly: { eur: 199000, usd: 199000 },
    limits: {
      limit_projects: '30',
      limit_runs: '8000',
      limit_suggestions: '8000',
      limit_seats: '10',
      limit_devices: '0',
      limit_concurrency: '8',
      limit_budget_usd: '70',
      limit_retention_days: '180',
      limit_premium_models: 'true',
    },
  },
];

const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
];

const APP_ORIGIN = process.env.PITCHBOX_APP_ORIGIN ?? 'https://app.pitchbox.app';
const PREVIEW_ORIGIN = process.env.PITCHBOX_PREVIEW_ORIGIN ?? 'https://preview.pitchbox.app';
const SITE_ORIGIN = process.env.PITCHBOX_SITE_ORIGIN ?? 'https://pitchbox.app';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WITH_HEAD_OFFICE = args.includes('--head-office');
const SECRETS_OUT = args[args.indexOf('--secrets-out') + 1] ?? null;

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is required (sk_test_... or sk_live_...)');
  process.exit(1);
}
const LIVE = KEY.startsWith('sk_live_');

function form(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => form(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      form(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return out;
  }
  out.append(prefix, String(value));
  return out;
}

async function stripe<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const verb = method ?? (body ? 'POST' : 'GET');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: verb,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? form(body) : undefined,
  });
  const payload: unknown = await res.json();
  if (!res.ok) {
    let message = '';
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const err = payload.error;
      if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
        message = err.message;
      }
    }
    throw new Error(`${verb} /v1/${path} -> ${res.status} ${message}`);
  }
  // Stripe's response shape is documented per endpoint; the callers below name
  // the fields they read, and a wrong shape surfaces immediately as undefined.
  return payload as T;
}

function log(action: string, detail: string) {
  console.log(`${action.padEnd(9)} ${detail}`);
}

async function ensureProduct(plan: Plan): Promise<StripeProduct> {
  const list = await stripe<StripeList<StripeProduct>>('products?limit=100');
  const existing = list.data.find((p) => p.metadata?.plan === plan.slug);
  const metadata: Metadata = { plan: plan.slug, ...plan.limits };
  const payload = {
    name: plan.name,
    description: plan.description,
    tax_code: TAX_CODE,
    metadata,
  };
  if (!existing) {
    if (DRY_RUN) {
      log('create', `product ${plan.name}`);
      return {
        id: `dry_${plan.slug}`,
        name: plan.name,
        description: plan.description,
        tax_code: TAX_CODE,
        metadata,
      };
    }
    const created = await stripe<StripeProduct>('products', { ...payload, active: true });
    log('created', `product ${plan.name} ${created.id}`);
    return created;
  }
  const drift =
    existing.name !== payload.name ||
    existing.description !== payload.description ||
    existing.tax_code !== TAX_CODE ||
    Object.entries(metadata).some(([k, v]) => existing.metadata?.[k] !== v);
  if (!drift) {
    log('ok', `product ${plan.name} ${existing.id}`);
    return existing;
  }
  if (DRY_RUN) {
    log('update', `product ${plan.name} ${existing.id}`);
    return existing;
  }
  const updated = await stripe<StripeProduct>(`products/${existing.id}`, payload);
  log('updated', `product ${plan.name} ${existing.id}`);
  return updated;
}

async function ensurePrice(
  plan: Plan,
  product: StripeProduct,
  interval: 'month' | 'year',
): Promise<StripePrice> {
  const amounts = interval === 'month' ? plan.monthly : plan.yearly;
  const lookupKey = `pitchbox_${plan.slug}_${interval}ly`;
  const list = await stripe<StripeList<StripePrice>>(
    `prices?product=${product.id}&limit=100&expand[]=data.currency_options`,
  );
  const active = list.data.filter((p) => p.active && p.recurring?.interval === interval);
  const match =
    active.find((p) => p.lookup_key === lookupKey) ??
    active.find((p) => p.metadata?.interval === interval);

  if (match && match.currency === 'eur' && match.unit_amount === amounts.eur) {
    const patch: Record<string, unknown> = {};
    if (match.lookup_key !== lookupKey) patch.lookup_key = lookupKey;
    // `tax_behavior` is writable exactly once, while it is still `unspecified`.
    if (match.tax_behavior === 'unspecified') patch.tax_behavior = 'exclusive';
    if (match.currency_options?.usd?.unit_amount !== amounts.usd) {
      patch.currency_options = { usd: { unit_amount: amounts.usd } };
    }
    if (match.metadata?.plan !== plan.slug || match.metadata?.interval !== interval) {
      patch.metadata = { plan: plan.slug, interval };
    }
    if (Object.keys(patch).length === 0) {
      log('ok', `price ${lookupKey} ${match.id}`);
      return match;
    }
    if (DRY_RUN) {
      log('update', `price ${lookupKey} ${match.id} (${Object.keys(patch).join(', ')})`);
      return match;
    }
    const updated = await stripe<StripePrice>(`prices/${match.id}`, patch);
    log('updated', `price ${lookupKey} ${match.id} (${Object.keys(patch).join(', ')})`);
    return updated;
  }

  // Amount changed, or there is no price yet: prices are immutable, so create a
  // new one and move the lookup key onto it. Subscriptions already on the old
  // price keep it until they are explicitly migrated.
  if (DRY_RUN) {
    log(match ? 'reprice' : 'create', `price ${lookupKey} ${amounts.eur} eur / ${amounts.usd} usd`);
    return (
      match ?? {
        id: `dry_${lookupKey}`,
        product: product.id,
        active: true,
        currency: 'eur',
        unit_amount: amounts.eur,
        lookup_key: lookupKey,
        tax_behavior: 'exclusive',
        metadata: { plan: plan.slug, interval },
        recurring: { interval },
      }
    );
  }
  const created = await stripe<StripePrice>('prices', {
    product: product.id,
    currency: 'eur',
    unit_amount: amounts.eur,
    recurring: { interval },
    tax_behavior: 'exclusive',
    lookup_key: lookupKey,
    transfer_lookup_key: match ? true : undefined,
    currency_options: { usd: { unit_amount: amounts.usd, tax_behavior: 'exclusive' } },
    metadata: { plan: plan.slug, interval },
  });
  log('created', `price ${lookupKey} ${created.id}`);
  if (match) {
    await stripe<StripePrice>(`prices/${match.id}`, { active: false });
    log('retired', `price ${match.id} (replaced by ${created.id})`);
  }
  return created;
}

async function ensurePortal(catalogue: { product: StripeProduct; prices: StripePrice[] }[]) {
  const payload = {
    business_profile: {
      headline: 'Manage your Pitchbox subscription',
      privacy_policy_url: `${SITE_ORIGIN}/privacy`,
      terms_of_service_url: `${SITE_ORIGIN}/terms`,
    },
    default_return_url: `${APP_ORIGIN}/settings/billing`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['address', 'email', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'],
        },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        // What makes a downgrade keep what the customer already paid for. With
        // these conditions the portal does not apply a cheaper price straight
        // away: it builds a Subscription Schedule whose second phase starts at
        // `current_period_end`, leaves the subscription on its current price
        // until then, and releases itself once the new phase begins. An
        // upgrade is unaffected and stays immediate with proration, since
        // neither condition matches it.
        //
        // `decreasing_item_amount` covers a cheaper plan, `shortening_interval`
        // a move from yearly to monthly. Measured against the real test account
        // on 2026-09-10: it defers **across products** as well, which is what
        // #613 assumed was impossible - the portal's own confirmation reads
        // "Your subscription will be updated at the end of your current billing
        // period", and the resulting schedule carries Growth until period end
        // and Solo after it. So Solo/Growth/Scale stay three products, and this
        // app owns no scheduling code.
        schedule_at_period_end: {
          conditions: [{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }],
        },
        products: catalogue.map(({ product, prices }) => ({
          product: product.id,
          prices: prices.map((p) => p.id),
        })),
      },
    },
    metadata: { pitchbox: 'portal' },
  };
  // The portal configuration and the tax settings are written unconditionally:
  // the payload above is the full desired state, so a PATCH with it is the diff.
  const list = await stripe<StripeList<StripePortalConfiguration>>(
    'billing_portal/configurations?limit=100',
  );
  const existing =
    list.data.find((c) => c.metadata?.pitchbox === 'portal') ?? list.data.find((c) => c.is_default);
  if (DRY_RUN) {
    log(existing ? 'update' : 'create', `portal configuration ${existing?.id ?? ''}`.trim());
    return existing ?? { id: 'dry_portal', is_default: true, metadata: { pitchbox: 'portal' } };
  }
  const saved = existing
    ? await stripe<StripePortalConfiguration>(
        `billing_portal/configurations/${existing.id}`,
        payload,
      )
    : await stripe<StripePortalConfiguration>('billing_portal/configurations', payload);
  log(existing ? 'synced' : 'created', `portal configuration ${saved.id}`);
  return saved;
}

async function ensureWebhook(url: string, label: string) {
  const list = await stripe<StripeList<StripeWebhookEndpoint>>('webhook_endpoints?limit=100');
  const existing = list.data.find((w) => w.url === url);
  if (existing) {
    const sameEvents =
      existing.enabled_events.length === WEBHOOK_EVENTS.length &&
      WEBHOOK_EVENTS.every((e) => existing.enabled_events.includes(e));
    if (sameEvents && existing.status === 'enabled') {
      log('ok', `webhook ${label} ${existing.id}`);
      return { endpoint: existing, secret: null };
    }
    if (DRY_RUN) {
      log('update', `webhook ${label} ${existing.id}`);
      return { endpoint: existing, secret: null };
    }
    const updated = await stripe<StripeWebhookEndpoint>(`webhook_endpoints/${existing.id}`, {
      enabled_events: WEBHOOK_EVENTS,
      disabled: false,
    });
    log('updated', `webhook ${label} ${updated.id}`);
    return { endpoint: updated, secret: null };
  }
  if (DRY_RUN) {
    log('create', `webhook ${label} ${url}`);
    return {
      endpoint: {
        id: 'dry_webhook',
        url,
        status: 'enabled',
        enabled_events: WEBHOOK_EVENTS,
        metadata: {},
      },
      secret: null,
    };
  }
  const created = await stripe<StripeWebhookEndpoint>('webhook_endpoints', {
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: `Pitchbox ${label}`,
    metadata: { pitchbox: label },
  });
  log('created', `webhook ${label} ${created.id}`);
  // The signing secret comes back only on creation, never again.
  return { endpoint: created, secret: created.secret ?? null };
}

async function ensureTax() {
  const current = await stripe<StripeTaxSettings>('tax/settings');
  const payload: Record<string, unknown> = {
    defaults: { tax_behavior: 'exclusive', tax_code: TAX_CODE },
  };
  if (WITH_HEAD_OFFICE) {
    const parts = ['LINE1', 'CITY', 'POSTAL_CODE', 'STATE', 'COUNTRY'];
    const missing = parts.filter((k) => !process.env[`STRIPE_HEAD_OFFICE_${k}`]);
    if (missing.length) {
      throw new Error(
        `--head-office needs STRIPE_HEAD_OFFICE_${missing.join(', STRIPE_HEAD_OFFICE_')}`,
      );
    }
    payload.head_office = {
      address: {
        line1: process.env.STRIPE_HEAD_OFFICE_LINE1,
        city: process.env.STRIPE_HEAD_OFFICE_CITY,
        postal_code: process.env.STRIPE_HEAD_OFFICE_POSTAL_CODE,
        state: process.env.STRIPE_HEAD_OFFICE_STATE,
        country: process.env.STRIPE_HEAD_OFFICE_COUNTRY,
      },
    };
  }
  if (DRY_RUN) {
    log('update', `tax settings (status ${current.status})`);
    return current;
  }
  const saved = await stripe<StripeTaxSettings>('tax/settings', payload);
  log('synced', `tax settings status=${saved.status}`);
  if (saved.status !== 'active') {
    console.warn(
      '  tax is not active yet: set the head office address (dashboard, or --head-office with STRIPE_HEAD_OFFICE_*)',
    );
  }
  return saved;
}

async function main() {
  const account = await stripe<StripeAccount>('account');
  console.log(
    `account  ${account.id} (${LIVE ? 'LIVE' : 'test'}) charges_enabled=${account.charges_enabled} payouts_enabled=${account.payouts_enabled}`,
  );
  if (LIVE && !account.charges_enabled) {
    console.warn('  live account cannot charge yet: finish activation in the dashboard first');
  }
  console.log('');

  const catalogue: { product: StripeProduct; prices: StripePrice[] }[] = [];
  for (const plan of PLANS) {
    const product = await ensureProduct(plan);
    const monthly = await ensurePrice(plan, product, 'month');
    const yearly = await ensurePrice(plan, product, 'year');
    catalogue.push({ product, prices: [monthly, yearly] });
  }
  console.log('');

  const portal = await ensurePortal(catalogue);
  const production = await ensureWebhook(`${APP_ORIGIN}/api/stripe/webhook`, 'production');
  const preview = await ensureWebhook(`${PREVIEW_ORIGIN}/api/stripe/webhook`, 'preview');
  await ensureTax();

  const secrets: string[] = [];
  if (production.secret) secrets.push(`STRIPE_WEBHOOK_SECRET=${production.secret}`);
  if (preview.secret) secrets.push(`STRIPE_WEBHOOK_SECRET_PREVIEW=${preview.secret}`);

  console.log('');
  console.log('catalogue');
  for (const { product, prices } of catalogue) {
    console.log(`  ${(product.metadata?.plan ?? product.id).padEnd(8)} ${product.id}`);
    for (const p of prices) console.log(`    ${(p.lookup_key ?? '-').padEnd(24)} ${p.id}`);
  }
  console.log(`  portal   ${portal.id}`);
  console.log(`  webhook  ${production.endpoint.id} -> ${production.endpoint.url}`);
  console.log(`  webhook  ${preview.endpoint.id} -> ${preview.endpoint.url}`);

  if (secrets.length && SECRETS_OUT) {
    await writeFile(SECRETS_OUT, `${secrets.join('\n')}\n`, { mode: 0o600 });
    console.log(`\nwrote ${secrets.length} webhook signing secret(s) to ${SECRETS_OUT} (mode 600)`);
  } else if (secrets.length) {
    console.log(
      `\n${secrets.length} webhook endpoint(s) were created. Their signing secrets print once:`,
    );
    for (const s of secrets) console.log(`  ${s}`);
    console.log(
      'Store them now, or re-run with --secrets-out <path>. Stripe never shows them again.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
