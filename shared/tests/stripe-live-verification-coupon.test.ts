// LOR-188: the restrictions that keep the live-verification coupon from
// leaking into a real sale are decided here, pure and unit-tested without a
// key, because scripts/stripe-setup.ts and scripts/stripe-probe.ts both call
// the real Stripe API at import time and cannot be exercised without one -
// the same reasoning shared/tests/stripe-webhook-endpoints.test.ts already
// applies to stripeModeFromKey.
import { describe, expect, it } from 'vitest';
import {
  LIVE_VERIFICATION_COUPON_DURATION,
  LIVE_VERIFICATION_COUPON_ID,
  LIVE_VERIFICATION_EXPIRY_DAYS,
  LIVE_VERIFICATION_MAX_REDEMPTIONS,
  LIVE_VERIFICATION_PROMOTION_CODE,
  liveVerificationExpiresAt,
} from '../src/stripe/live-verification-coupon.js';

describe('the LOR-188 live-verification coupon decision', () => {
  it('caps redemptions at exactly one, on both the coupon and the promotion code', () => {
    // The issue's own restriction: one real redemption proves the webhook
    // path once, a second is already the leak it guards against. A larger
    // cap here would silently widen every place that reads this constant.
    expect(LIVE_VERIFICATION_MAX_REDEMPTIONS).toBe(1);
  });

  it('discounts the first invoice only, not every future renewal', () => {
    expect(LIVE_VERIFICATION_COUPON_DURATION).toBe('once');
  });

  it('uses a stable custom coupon id, not a placeholder Stripe would reject', () => {
    // Stripe coupon/promotion-code ids and codes accept letters, digits,
    // underscores and dashes; anything else is a real 400 on creation.
    expect(LIVE_VERIFICATION_COUPON_ID).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(LIVE_VERIFICATION_COUPON_ID.length).toBeGreaterThan(0);
  });

  it('is not a guessable word a stranger could type into Checkout before the redemption cap catches it', () => {
    // Stripe's own charset for a promotion code: letters, digits, dashes.
    expect(LIVE_VERIFICATION_PROMOTION_CODE).toMatch(/^[A-Za-z0-9-]+$/);
    // Long enough, and mixing letters with digits, to rule out a short
    // dictionary word like "FREE100" or "PITCHBOXFREE" standing in for it.
    expect(LIVE_VERIFICATION_PROMOTION_CODE.length).toBeGreaterThanOrEqual(16);
    expect(LIVE_VERIFICATION_PROMOTION_CODE).toMatch(/[0-9]/);
  });

  it('expires a bounded number of days after creation, never immediately and never indefinitely', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const expiresAt = liveVerificationExpiresAt(now);

    expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(expiresAt.getTime() - now.getTime()).toBe(
      LIVE_VERIFICATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
    // Stripe rejects a coupon's redeem_by more than 5 years out - staying
    // far under that is what makes this "an expiry" rather than a decoration.
    const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - now.getTime()).toBeLessThan(fiveYearsMs);
  });

  it('is a pure function of the instant it is called with, not the wall clock', () => {
    const a = liveVerificationExpiresAt(new Date('2026-01-01T00:00:00Z'));
    const b = liveVerificationExpiresAt(new Date('2026-01-01T00:00:00Z'));
    expect(a.getTime()).toBe(b.getTime());
  });
});
