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
- These parameters are **rejected**, per Stripe's own documentation:
  `subscription_data.default_tax_rates`, `payment_method_collection`,
  `payment_method_configuration`, `payment_method_options`,
  `payment_method_types`, `saved_payment_method_options`,
  `shipping_address_collection`, `shipping_options`,
  `subscription_data.application_fee_percent`,
  `subscription_data.on_behalf_of`, `subscription_data.transfer_data`,
  `subscription_data.invoice_settings`. Verified against the real test
  account under `2025-03-31.basil` (#550/#551 PR): `payment_method_types`,
  `shipping_address_collection` and `subscription_data.invoice_settings` do
  reject outright with exactly that message. `automatic_tax[enabled]` and
  `tax_id_collection[enabled]` are a narrower case Stripe's own error message
  states directly - Managed Payments pins both to `true` and only the
  opposite value errors ("must be true when Managed Payments is enabled");
  omitting either is silently equivalent to `true`. Two more from Stripe's
  own list, `customer_update[name]` and `customer_update[address]`, did
  **not** error in that same test-mode run - a discrepancy worth knowing
  about but not worth relying on, since the app never sets any of the above
  either way.
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
portal configuration, this run's own webhook endpoint, and the Stripe Tax
defaults.

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

## Where an org's entitlements actually come from

`shared/src/plans.ts` is the one place in the app that turns a plan into
numbers (`resolveEntitlements(db, orgId)`), and everything else - the
extension payload, a settings form, an enforcement point - reads its return
value rather than a plan id. It carries its own fallback catalogue, kept
equal to the table above and to the Stripe metadata `scripts/stripe-setup.ts`
writes: not a second source of truth, but what an org resolves to _before_
Stripe is asked - Free (which has no Stripe object, ever), an instance-admin
grant (never Stripe-backed), and the gap before a subscription's first
webhook lands. `organizations.plan`/`plan_source`/`plan_updated_at` record
which plan and why, and `organizations.stripe_customer_id` records the
org's Stripe customer (#550) - created lazily on first checkout and kept
there rather than on `org_subscriptions`, since a customer can exist with
no subscription yet (or after one is cancelled) and `org_subscriptions`
is itself deleted wholesale when Stripe's subscription is. `org_subscriptions`
mirrors a live subscription's metadata limits per org, one row per org,
separate from `organizations` because a subscription has its own lifecycle -
Stripe can delete it out from under us (see "A customer can ask Stripe to
delete their data" below), and that has to look like a row disappearing,
not a pile of nulled columns. `stripe_events` is the webhook's own
idempotency ledger (#551): Stripe's event id as the primary key, so a
retried or replayed delivery is a no-op rather than a double-apply.

Precedence, highest first: self-host (unlimited, no plan, no Stripe key
required); an instance-admin grant (`plan_source='grant'`), which survives
whatever Stripe says about the same org; a mirrored subscription
(`org_subscriptions`); the fallback catalogue, keyed by `organizations.plan`
and normalized to Free if that value does not name a real plan. `webhooks` is
a feature flag rather than a metered limit, so it has no Stripe metadata
counterpart and always comes from the catalogue, keyed by plan id, even for a
mirrored subscription.

## What a tenant sees of their own model spend

`monthlyRunBudgetUsd` (`shared/src/plans.ts`) is a real dollar ceiling, mirrored
onto `organizations.monthly_run_budget_usd` so `shared/src/org-quota.ts` can
enforce it without re-resolving entitlements, and `getOrgUsage`
(`shared/src/usage.ts`) reports what a period has spent against it in USD
(`costUsd`). None of that changes (LOR-182): the enforced number and the
number `getOrgUsage` computes stay in dollars, because re-denominating the
enforcement itself would be a second, larger change and would leave the
enforced limit and the number shown disagreeing.

What changed is what a **tenant** may be shown of it on the cloud edition.
Before LOR-182, the dashboard's "Campaign spend"/"Assistant spend" cards,
`/settings/billing`'s "Model spend this period" and `/settings/organization`'s
month-to-date figure all rendered `costUsd` as a currency amount - which is
the deployment's own Gateway bill, not something the tenant bought, and it
invites reasoning about margin that is none of a customer's business. On
cloud, no page outside `/settings/admin` prints a dollar figure any more:

- The dashboard's two spend cards are gone outright - there is no allowance
  to express them as a percentage of, they were always our cost, not theirs.
- `/settings/organization`'s "Quota & budget" card (month-to-date spend,
  remaining budget, and the raw USD ceiling itself) is gone; it duplicated
  the same plan-derived ceiling `/settings/billing` already shows, in the
  one place that also let a tenant edit it directly.
- `/settings/billing`'s "Model spend this period" becomes "Model allowance
  used", a percentage of the plan's ceiling plus its existing bar - never a
  currency amount, a per-run cost, or the ceiling itself in dollars. A
  tenant who is approaching or over the ceiling still sees that coming
  (the percentage keeps counting past 100), which a hidden internal-only
  guard would not give them.

Self-host (edition unset) is unaffected on every one of those surfaces: the
operator pays the Gateway bill there, so it is their own number to see, same
as it always was. `getOrgUsage` keeps returning `costUsd` unchanged for the
surfaces that may still show it in dollars: `/settings/admin` (the instance
figure) and self-host.

## Where the marketing site's pricing page gets its numbers

`pitchbox-landing` (a separate repo, its own deploy, no database) cannot call
`resolveEntitlements`, so its `/pricing` page does not restate the table above by
hand. `pnpm run plans:export` (`scripts/export-plan-catalogue.ts`) writes
`docs/plan-catalogue.json` from `listPlans()` itself; `shared/tests/plan-catalogue-artifact.test.ts`
fails this repo's CI if that file is committed out of sync. The landing repo pulls it
from GitHub raw content only when someone runs its own `pnpm run plans:refresh`
on purpose, the same shape as its existing token-drift snapshot (`docs/design/DECISIONS.md`
D24/D26): a deliberate, human-run refresh, never a live fetch at the landing's own
build or request time. Run `plans:export` and commit the result whenever
`PLAN_CATALOGUE` changes, the same way `stripe-setup.ts` needs a run after a
metadata change.

## What happens at a limit, at a downgrade, and after a failed payment

- A limit is a **hard refusal** with an upgrade prompt: no silent degrade to a
  cheaper model, no queueing, no billed overage. An org that ends up over a
  new, lower limit (a downgrade, or a subscription lapsing to Free) keeps
  every row it already has - it can read and run what exists, it just cannot
  create past the new ceiling until it is back under it or upgrades.
- An upgrade takes effect immediately: the webhook mirrors whatever Stripe's
  live subscription reports, so a higher limit applies as soon as Stripe
  raises the price, and usage already spent in the period keeps counting
  against the new ceiling rather than resetting.
- A downgrade is only ever mirrored once Stripe's live subscription actually
  reports the new plan - never anticipated. The customer portal defers it for
  us: its configuration carries
  `subscription_update[schedule_at_period_end][conditions]` =
  `decreasing_item_amount` + `shortening_interval`, so a cheaper plan, or a
  move from yearly to monthly, leaves the subscription on its current price and
  creates a **Subscription Schedule** whose second phase starts at
  `current_period_end` (`end_behavior: release`, so the schedule releases
  itself once that phase begins and the subscription simply continues on the
  new price). The org therefore keeps what it paid for until period end, and
  the plan swap arrives here as an ordinary `customer.subscription.updated`.
  This works **across products**, so Solo/Growth/Scale staying three separate
  products costs nothing and this app owns no scheduling code: measured against
  the real test account on 2026-09-10, driving the portal from Growth monthly
  down to Solo monthly, which answered "Your subscription will be updated at
  the end of your current billing period on October 10, 2026" and produced a
  two-phase schedule (Growth until the 10th, Solo after). An **upgrade** is
  unaffected and stays immediate with proration, since neither condition
  matches it.
- A failed payment (`invoice.payment_failed`) starts a **14-day grace period**,
  counted from the first failure rather than restarted by each Smart Retries
  reattempt. The org keeps working normally during grace; a banner and a
  notification both name the exact date it ends. Past it, the org is
  **read-only**: no new runs, suggestions, accepts, projects, campaigns,
  invites or devices (refused with `plan_payment_required`, distinct from
  `plan_limit_reached`) - everything already there stays readable, the Inbox
  keeps working, drafts can still be marked sent, and the extension's inbound
  sync routes keep accepting data. The customer portal is never refused,
  read-only or not - it is the one path back to a working account.
  `isOrgReadOnly` (`shared/src/plans.ts`) is the one predicate every
  enforcement point reads. `invoice.paid` clears grace and read-only in one
  step; `customer.subscription.deleted` (cancelled, or Stripe gave up on
  dunning) drops the org to Free, a real working plan, not a lockout.

## Running the setup

```bash
# see what would change, against either mode
STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/stripe-setup.ts --dry-run

# apply, capturing the webhook signing secret if it has to create one
STRIPE_SECRET_KEY=sk_live_... pnpm exec tsx scripts/stripe-setup.ts \
  --secrets-out ~/.config/pitchbox-stripe-live-webhooks.env
```

It is idempotent: an object that already matches is reported `ok` and left alone.
A price whose amount changed cannot be edited (Stripe prices are immutable), so
the script creates the new price, moves the lookup key onto it, and deactivates
the old one. Subscriptions already on the old price keep it until they are
migrated on purpose.

The mode of the key decides which webhook endpoint this run owns (see
"Webhooks" below): a live key never creates or touches the preview endpoint,
and a test key never creates or touches the production one. If the account
still holds an _enabled_ endpoint for the other mode, this run reports it and
disables it - never deletes it, so it stays visible in the dashboard - rather
than leaving it to retry a signature it can never verify until Stripe disables
it on its own.

A webhook signing secret is returned only when the endpoint is created. Pass
`--secrets-out` or copy it from the run output; Stripe never shows it again.

## Verifying against the real account

`scripts/stripe-setup.ts` only ever writes to Stripe; nothing checks that what
this repo sends is actually accepted, or that the recorded catalogue still
matches the account, until `pnpm run stripe:probe` (`scripts/stripe-probe.ts`)
does. It talks to the real **test-mode** account (`~/.config/pitchbox-stripe-
test.key`), so it cannot run on a CI runner and is deliberately a script, not
a test in the suite: `shared/tests/billing-checkout-portal.test.ts` used to
hold this check and turned `main` red on a runner that had no key while every
PR stayed green, which is what moved it here. It proves four things no
fixture can: the Checkout payload this repo builds is one Stripe accepts
under Managed Payments (including that the parameters Stripe rejects are
absent), a portal session opens for a customer this repo created, the
prices/metadata recorded in `shared/tests/fixtures/stripe/catalogue.json`
still match the live account (`--refresh` rewrites that fixture after a
deliberate catalogue change), and the portal configuration still carries the
two `schedule_at_period_end` conditions - a configuration that lost them
applies a downgrade immediately, which is invisible from this repo and costs a
customer money.

It has one blind spot, deliberately not papered over.
`subscription_update[products]`, the list that decides which prices a customer
can switch between, is accepted on write and **not returned** on read: the
object comes back with `enabled`, `default_allowed_updates`,
`proration_behavior`, `schedule_at_period_end`, `billing_cycle_anchor` and
`trial_update_behavior`, and nothing else. Reading it back therefore proves
nothing about the price list, so the probe does not claim to check it; that
half is verified by opening a portal session for a subscribed customer in test
mode and looking at the page. Run the probe before a billing release and after
any change to the price catalogue or the portal. It never writes to the app
database.

## Exercising the live billing path without paying

Once a Stripe grant is off (LOR-187), testing the live path - Checkout, the
webhook, the mirrored `org_subscriptions` row - would otherwise mean a real
charge to whoever runs it, a real Managed Payments fee, and a real invoice to
reconcile, for a subscription bought only to watch the webhook fire.
`scripts/stripe-setup.ts` provisions a single-use, 100%-off coupon for
exactly that instead (LOR-188), in both modes: the pure decision behind it -
the code, the redemption cap, the expiry - lives in
`shared/src/stripe/live-verification-coupon.ts`, unit-tested without a key.

The promotion code is `PITCHBOX-VERIFY-N4K7QZX9WT`. Type it into Checkout's
"Add promotion code" field (`allow_promotion_codes: true` is already set,
`shared/src/billing/checkout.ts`) to bring any plan's first invoice to zero.
It is named here on purpose rather than left for someone to find
undocumented, and it is restricted the same way documenting it demands:

- **100% off, `duration: once`** - only the first invoice is free; the
  subscription renews at full price afterward, so cancel it once verified
  rather than relying on the discount to keep it free.
- **`max_redemptions: 1`** on both the coupon and its promotion code - one
  real redemption is exactly what proves the webhook path once, and a second
  is already the leak this guards against.
- **An expiry** 30 days after the setup script creates it. Past that instant
  the coupon is not deleted, only inert; delete it in the dashboard and
  re-run the setup script to mint a fresh one if the window is missed.

A subscription redeemed with it still mirrors normally: the discount changes
what the invoice collects, not the subscription's price or product, so the
webhook (`shared/src/billing/webhook.ts`) records it `active` with the
plan's real limits, the same as a full-price subscription. `pnpm run
stripe:probe` reports the coupon's and promotion code's presence and
restrictions, but only in test mode ("Verifying against the real account"
above, it never holds a live key), so verify a live redemption by hand,
once, before relying on it.

## Environment

| Variable                      | Where             | What                                                                                                                       |
| ----------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PITCHBOX_BILLING`            | web (server only) | `on` to enable the billing routes; unset means self-host posture, same 404 `/api/auth/*` takes when `PITCHBOX_AUTH` is off |
| `STRIPE_SECRET_KEY`           | web (server only) | `sk_live_…` in production, `sk_test_…` in preview and locally                                                              |
| `STRIPE_WEBHOOK_SECRET`       | web (server only) | signing secret of **that deployment's own** endpoint                                                                       |
| `STRIPE_PORTAL_CONFIGURATION` | web (server only) | optional; pins the portal configuration instead of the default                                                             |
| `PITCHBOX_APP_ORIGIN`         | setup script      | defaults to `https://app.pitchbox.app`                                                                                     |
| `PITCHBOX_PREVIEW_ORIGIN`     | setup script      | defaults to `https://preview.pitchbox.app`                                                                                 |

Production and preview have **separate webhook endpoints with separate signing
secrets** on purpose: a preview deployment holding the production secret could
write production billing state. Never copy one into the other.

Which endpoint exists in which mode is derived, not chosen: `scripts/stripe-setup.ts`
reads the mode off the `sk_live_`/`sk_test_` prefix of the key it is given and creates
or reconciles only that mode's own endpoint, so there is exactly one enabled
webhook endpoint per mode, never both origins in both modes (LOR-156, fixing an
account that held all four - the wrong-mode pair could never verify a signature
and got retried until Stripe disabled them).

A Docker deployment needs each of those four in **both** compose files, not
only in `.env`: `docker-compose.app.yml` enumerates the container's
environment instead of passing `.env` through, and `docker-compose.bluegreen.yml`
replaces that whole block through its `x-web-common` anchor, so a variable
present in one place still reaches nothing. Prod held a live key in `.env` and
in neither file on 2026-09-10, which answers every billing route 404
`billing_disabled` while looking configured. `tests/docker-mail-env.test.ts`
now fails when a variable `loadStripeEnv` reads is missing from either file.

Nothing reads a publishable key: Checkout is hosted and the app only ever
redirects to a session URL, so there is no `STRIPE_PUBLISHABLE_KEY` here and
setting one configures nothing.

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

What is set on the live account, as of 2026-09-10 (Settings > Billing >
Subscriptions and emails, dashboard only - no API key reaches it):

| Setting                                         | State                             |
| ----------------------------------------------- | --------------------------------- |
| Emails about upcoming renewals                  | on                                |
| Emails about expiring cards                     | on                                |
| Emails when card payments fail                  | on                                |
| Emails when bank debit payments fail            | on                                |
| Payment method updates                          | link to a Stripe-hosted page      |
| Link for customers to manage their subscription | on, to the Stripe customer portal |
| Trial reminder                                  | off - there is no trial           |

All five were **off** until then, which meant a customer whose card failed was
told nothing by Stripe, while the app started a 14-day grace and showed a
banner only to somebody who happened to open it. Prod also has no mail provider
configured, so the app itself sent nothing either.

How that lines up with the grace period: Stripe retries, emails the customer on
each failure, and **cancels the subscription after 15 days incomplete** (or when
all retries fail), leaving the invoice past-due. The app turns the org
read-only at day 14, so the order is: failure and email, 14 days of grace,
read-only, then the cancellation arrives as
`customer.subscription.deleted` and drops the org to Free, a working plan.

**Payment method updates is a one-way door, and it is now through it.** Until
2026-09-10 the account was on the legacy "mix of both" setup, where all four
emails pointed at `https://pitchbox.app`, the marketing homepage, where no card
can be updated. It is now the Stripe-hosted page: the customer updates the card
without signing in to the app, and the destination stops depending on our
deploy. The dashboard confirms that switch with "this change cannot be
reversed", and it means it - the legacy option is gone from the page
afterward, and the custom-URL fields with it. The only remaining choice there
is a single custom link, which would need an authenticated page of ours that
can actually take a card, which Managed Payments does not give us.

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
prices with a monthly/yearly toggle, a downgrade deferred to period end,
cancellation at period end with a reason, invoice history), returning to
`/settings/billing`.

What the app does **not** show yet is a plan change the portal has scheduled: a
customer who downgrades sees "Your service will be updated on `<date>`" in the
portal, while `/settings/billing` keeps reporting the current plan with no hint
that it changes at period end, because `org_subscriptions` mirrors the live
subscription and the pending phase lives on a Subscription Schedule this app
never reads.

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
