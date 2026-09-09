# Billing

Pitchbox is free to self-host: nothing on this page runs unless the deployment is
the hosted edition. The hosted plans are sold through Stripe Checkout, managed by
the customer in the Stripe customer portal, and enforced in the app from the plan
limits Stripe stores on each product.

Self-host keeps `PITCHBOX_AUTH=off` and no Stripe keys, and behaves as it always
has: every limit off, every runner available.

## The plan catalogue lives in Stripe, not in the code

`scripts/stripe-setup.ts` is the source of truth for the catalogue and creates or
reconciles every object the app needs: three products, six prices, the customer
portal configuration, the two webhook endpoints, and the Stripe Tax defaults.

| Plan   | Monthly | Annual | Projects | Runs / month | Suggestions / month | Seats |
| ------ | ------- | ------ | -------- | ------------ | ------------------- | ----- |
| Free   | 0       | 0      | 1        | 20           | 50                  | 1     |
| Solo   | €29     | €290   | 3        | 500          | 500                 | 1     |
| Growth | €79     | €790   | 10       | 2,000        | 2,000               | 3     |
| Scale  | €199    | €1,990 | 30       | 8,000        | 8,000               | 10    |

Annual is ten months of the monthly price (two months free). Prices are quoted
tax-exclusive: Stripe Tax adds VAT at checkout for the customer's country. USD is
carried as a `currency_options` entry on each price with the same headline
number, so a second currency needs no new price ids.

The Free plan has no Stripe object. It is the absence of a subscription, and its
limits live in the app.

**The app resolves prices by `lookup_key`, never by id**: `pitchbox_solo_monthly`,
`pitchbox_solo_yearly`, and the same shape for `growth` and `scale`. Entitlements
come from the product's `metadata` (`limit_projects`, `limit_runs`,
`limit_suggestions`, `limit_seats`, `limit_devices`, `limit_concurrency`,
`limit_budget_usd`, `limit_retention_days`, `limit_premium_models`), so changing
what a plan includes is a metadata edit plus a script run, not a deploy.

## Running the setup

```bash
# see what would change, against either mode
STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/stripe-setup.ts --dry-run

# apply, capturing any webhook signing secret it has to create
STRIPE_SECRET_KEY=sk_live_... pnpm exec tsx scripts/stripe-setup.ts \
  --secrets-out ~/.config/pitchbox-stripe-live-webhooks.env
```

It is idempotent: an object that already matches is reported `ok` and left alone.
A price whose amount changed cannot be edited (Stripe prices are immutable), so
the script creates the new price, moves the lookup key onto it, and deactivates
the old one. Subscriptions already on the old price keep it until they are
migrated on purpose.

A webhook signing secret is returned only when the endpoint is created. Pass
`--secrets-out` or copy it from the run output; Stripe never shows it again.

## Environment

| Variable                      | Where             | What                                                           |
| ----------------------------- | ----------------- | -------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`           | web (server only) | `sk_live_…` in production, `sk_test_…` in preview and locally  |
| `STRIPE_PUBLISHABLE_KEY`      | web               | `pk_live_…` / `pk_test_…`, safe to expose                      |
| `STRIPE_WEBHOOK_SECRET`       | web (server only) | signing secret of **that deployment's own** endpoint           |
| `STRIPE_PORTAL_CONFIGURATION` | web (server only) | optional; pins the portal configuration instead of the default |
| `PITCHBOX_APP_ORIGIN`         | setup script      | defaults to `https://app.pitchbox.app`                         |
| `PITCHBOX_PREVIEW_ORIGIN`     | setup script      | defaults to `https://preview.pitchbox.app`                     |

Production and preview have **separate webhook endpoints with separate signing
secrets** on purpose: a preview deployment holding the production secret could
write production billing state. Never copy one into the other.

## Webhooks

Both endpoints receive the same seven events:

- `checkout.session.completed` - the subscription exists, attach it to the org
- `customer.subscription.created` / `.updated` / `.deleted` - plan, status and
  period changes, including an upgrade, a downgrade and a cancellation
- `customer.subscription.trial_will_end` - three days before a trial ends
- `invoice.paid` - the period the org has paid for
- `invoice.payment_failed` - starts the grace period

The handler lives at `/api/stripe/webhook` and verifies the signature against
`STRIPE_WEBHOOK_SECRET` before reading the body.

## Tax

Stripe Tax is enabled and computes VAT at checkout from the customer's location,
with prices treated as tax-exclusive. It cannot compute anything for a country
where the account has no **tax registration**, and registrations are a decision
about where the business is registered to collect, not a setting to flip: until
they exist, automatic tax legitimately returns zero.

## What the script cannot do

Some things are only reachable with a live key, or only in the dashboard:

- **Branding** (icon, logo, brand colours) - dashboard only; `POST /v1/account`
  refuses with `Only live keys can access this method`.
- **Identity, payout account and public business details** - part of activation.
- **Tax registrations** - see above.
- **Subscription email settings** (receipts, dunning) - dashboard only.
