# Billing

Pitchbox is free to self-host: nothing on this page runs unless the deployment is
the hosted edition. The hosted plans are sold through Stripe Checkout, and the
plan limits Stripe stores on each product are what the app enforces.

Self-host keeps `PITCHBOX_AUTH=off` and no Stripe keys, and behaves as it always
has: every limit off, every runner available.

## Stripe is the merchant of record

The hosted edition sells through **Managed Payments**, so Stripe is the seller of
record for every subscription, not Pitchbox. Stripe calculates, collects, files
and remits sales tax, VAT and GST in more than 80 countries, handles fraud and
disputes, and answers transaction-level support. It costs 3.5% per transaction on
top of the normal processing fee.

That choice is not just a fee, it constrains the integration:

- Checkout Sessions **must** set `managed_payments[enabled]=true` and use API
  version `2025-03-31.basil` or later.
- These parameters are **rejected** on such a session: `automatic_tax`,
  `tax_id_collection`, `subscription_data.default_tax_rates`,
  `payment_method_collection`, `payment_method_configuration`,
  `payment_method_options`, `payment_method_types`,
  `saved_payment_method_options`, `customer_update[name]`,
  `customer_update[address]`, `shipping_address_collection`, `shipping_options`,
  `subscription_data.application_fee_percent`, `subscription_data.on_behalf_of`,
  `subscription_data.transfer_data`, `subscription_data.invoice_settings`.
- A subscription **cannot be created outside Checkout or a Payment Link**, and
  one-off invoices and customer invoice items are not available on it. Updating
  or cancelling an existing subscription through the API still works.
- Only hosted or embedded Checkout is supported: no Elements, no advanced
  integration, no Connect, and no custom domain on the checkout page.
- The customer's card statement reads `LINK.COM* PITCHBOX`.
- The checkout page is Link-branded ("Sold through Link"), offers card, Apple
  Pay, Google Pay and Link, and has its own "I'm purchasing as a business"
  checkbox: that is where a VAT number is collected, which is why
  `tax_id_collection` is neither available nor needed.
- **Adaptive Pricing** is on by default, so a customer without an explicit
  currency on the price pays a converted amount in their own currency. A currency
  that _is_ declared on the price (see below) is used as-is instead of converted.

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

Annual is ten months of the monthly price (two months free). Prices are
**tax-exclusive**: Stripe adds the customer's local tax at checkout, so an
Italian consumer buying Growth pays €79.00 plus €17.38 of IVA. USD is carried as
a `currency_options` entry on each price at the same headline number ($29 / $79 /
$199), which is deliberately below the converted euro amount.

The Free plan has no Stripe object. It is the absence of a subscription, and its
limits live in the app. **There is no trial**: Free is the trial, and it does not
expire, so `customer.subscription.trial_will_end` never fires even though the
endpoints subscribe to it.

**The app resolves prices by `lookup_key`, never by id**: `pitchbox_solo_monthly`,
`pitchbox_solo_yearly`, and the same shape for `growth` and `scale`. Entitlements
come from the product's `metadata` (`limit_projects`, `limit_runs`,
`limit_suggestions`, `limit_seats`, `limit_devices`, `limit_concurrency`,
`limit_budget_usd`, `limit_retention_days`, `limit_premium_models`), so changing
what a plan includes is a metadata edit plus a script run, not a deploy.

## What happens at a limit, and after a failed payment

- A limit is a **hard refusal** with an upgrade prompt: no silent degrade to a
  cheaper model, no queueing, no billed overage.
- A failed payment starts a **14-day grace period** during which the org keeps
  its plan. Stripe's dunning runs in that window; if nothing succeeds, the org
  drops to Free and its data stays intact.

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
- `customer.subscription.trial_will_end` - subscribed but unused, since there is
  no trial
- `invoice.paid` - the period the org has paid for
- `invoice.payment_failed` - starts the grace period

The handler lives at `/api/stripe/webhook` and verifies the signature against
`STRIPE_WEBHOOK_SECRET` before reading the body.

## Emails and support, which are mostly not ours

Under Managed Payments, Stripe sends receipts, invoices, refund and credit-note
notifications directly to the customer from Link, with PDFs attached. The receipt
settings in the Dashboard do not affect those. What is still configurable is the
upcoming-renewal reminder and the failed-payment (dunning) emails, in
**Subscription and email settings** in the Stripe Dashboard.

Two consequences worth knowing before support is promised anywhere:

- Stripe answers payment and subscription support through Link support, and
  escalates to the account's support email (`support@pitchbox.app`). **If nobody
  replies within 48 hours, Stripe may issue a refund without approval.**
- A customer can ask Stripe to delete their data, which cancels their
  subscription and deletes the matching Stripe objects (customer, invoices,
  subscription, charges) from our account too. The app must tolerate a
  subscription disappearing without a cancellation request of its own.

## Where a customer manages a subscription

Two places, and both are real: Stripe gives every Managed Payments customer
[link.com](https://link.com) for order history, cancellation, payment method and
billing address, and the app offers the same through the **Stripe customer
portal** (configuration created by the setup script, plan switching over the six
prices, cancellation at period end with a reason, invoice history), returning to
`/settings/billing`.

## Tax

Stripe handles indirect tax for the countries Managed Payments covers: it
calculates it at checkout, withholds it from the payout, and files and remits it.
Reports carry `withheld_tax` and `fee_net_of_withheld_tax` columns to separate it
from processing fees. For a country outside that coverage the seller stays
responsible, and Stripe Tax computes it at no extra charge.

Because Stripe is the merchant of record, the account needs no tax registration
of its own for the covered countries. The Stripe Tax defaults the setup script
writes (`exclusive`, tax code `txcd_10103001`, head office) stay in place: they
are what a non-Managed-Payments session would use, and the product tax code is
also what classifies the product for Stripe's own calculation.

## What the script cannot do

Some things are only reachable in the dashboard, whatever key you hold:

- **Branding** (icon, logo, brand colours) and the **public business details**
  (support email, website, statement descriptor). `POST /v1/account` refuses on
  your own account even with a live key.
- **Identity, payout account and activation.**
- **Managed Payments** itself, and the subscription email settings.
