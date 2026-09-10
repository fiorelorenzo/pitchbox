/**
 * The 100%-off coupon `scripts/stripe-setup.ts` provisions so the live
 * billing path (docs/billing.md "Exercising the live billing path without
 * paying") can be driven against the real Stripe account - Checkout, the
 * webhook, the mirrored `org_subscriptions` row - without a real charge, a
 * real Managed Payments fee, or a real invoice to reconcile afterwards
 * (LOR-188). Kept out of `scripts/stripe-setup.ts` and `scripts/stripe-probe.ts`
 * for the same reason `webhook-endpoints.ts` keeps `stripeModeFromKey` out of
 * them: both call the real Stripe API at import time, so a decision they
 * need cannot be unit-tested from inside either one.
 *
 * The coupon and its promotion code are immutable once created: Stripe's own
 * "Update a coupon" only lets `metadata`/`name` change afterwards, and
 * "Update a promotion code" only `active`/`metadata`/`restrictions` - never
 * `percent_off`, `duration`, `max_redemptions`, or either object's expiry
 * (`redeem_by` / `expires_at`). So every constant below only ever takes
 * effect on the object's first creation. Changing one does not migrate the
 * existing Stripe object, it orphans it - delete the orphan by hand in the
 * dashboard (the setup script never deletes it, the same restraint it
 * already takes with a mismatched webhook endpoint) before re-running so the
 * id/code below is free again.
 */

/** Custom coupon id, so the setup script looks this up the same way a price
 * is looked up by `lookup_key` - one direct fetch, not a scan of every
 * coupon on the account. The same id is used in both Stripe modes; test and
 * live are separate accounts, so there is no collision to avoid. */
export const LIVE_VERIFICATION_COUPON_ID = 'pitchbox_live_verification';

/**
 * The code typed into Checkout's "Add promotion code" field. Deliberately
 * not a guessable word (`FREE100`, `TESTING`, `PITCHBOXFREE`): a stranger
 * who finds this repo and tries it is refused the moment `max_redemptions`
 * is spent, but the code itself should not be the weak link a real customer
 * stumbles onto by chance. Fixed rather than generated per run - the setup
 * script looks a promotion code up by this exact string
 * (`GET /v1/promotion_codes?code=...`), so a random value would mint a new
 * one on every run instead of converging on one, the opposite of the
 * idempotent-by-lookup shape the price catalogue already uses.
 */
export const LIVE_VERIFICATION_PROMOTION_CODE = 'PITCHBOX-VERIFY-N4K7QZX9WT';

/**
 * Both the coupon and the promotion code carry this cap - belt and
 * suspenders, since only one promotion code ever points at this coupon. One
 * real redemption is exactly what proves the webhook path once; a second
 * redemption is already the leak the issue asks to guard against.
 */
export const LIVE_VERIFICATION_MAX_REDEMPTIONS = 1;

/**
 * `duration: 'once'`: the discount applies to the subscription's first
 * invoice only. This matches the ask - "a subscription I only want in order
 * to watch the webhook work" - a subscription that is cancelled once
 * verified, the same as any other test subscription, rather than one whose
 * price silently stays free forever if cancelling it is forgotten.
 */
export const LIVE_VERIFICATION_COUPON_DURATION = 'once' as const;

/**
 * How many days after creation the coupon (and its promotion code, pinned
 * to the same instant by the setup script) can still be redeemed. Stripe
 * caps a coupon's `redeem_by` at 5 years out; this is deliberately far
 * short of that - a bounded, unused window is the point (LOR-188:
 * "restricted so it cannot leak into a real sale"). Once it passes, the
 * object is not deleted, only inert, so a fresh window needs a fresh
 * id/code (see the module comment above).
 */
export const LIVE_VERIFICATION_EXPIRY_DAYS = 30;

/**
 * The instant the coupon (and its promotion code) stop being redeemable, as
 * a pure function of `now` rather than a date baked into a constant that
 * would go stale - `scripts/stripe-setup.ts` calls this once, at the moment
 * it actually creates the objects, and never again (Stripe will not let the
 * expiry be edited afterwards).
 */
export function liveVerificationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + LIVE_VERIFICATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}
