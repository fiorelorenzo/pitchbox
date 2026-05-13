import { describe, it, expect } from 'vitest';
import { computeBackoff, FAILURE_PAUSE_THRESHOLD } from '../../src/scheduler/backoff.js';

describe('computeBackoff', () => {
  it('returns 0 for the zero-attempts (no failure) case', () => {
    expect(computeBackoff(0)).toBe(0);
  });

  it('returns the base delay on the first failure', () => {
    expect(computeBackoff(1)).toBe(60_000);
  });

  it('doubles the delay on each subsequent failure', () => {
    expect(computeBackoff(2)).toBe(120_000);
    expect(computeBackoff(3)).toBe(240_000);
    expect(computeBackoff(4)).toBe(480_000);
  });

  it('caps the delay at the configured maximum (1 hour by default)', () => {
    // 60_000 * 2^6 = 3_840_000 → capped to 3_600_000
    expect(computeBackoff(7)).toBe(3_600_000);
    expect(computeBackoff(20)).toBe(3_600_000);
    expect(computeBackoff(1_000_000)).toBe(3_600_000);
  });

  it('honours custom base, max, and factor', () => {
    expect(computeBackoff(3, { baseMs: 1_000, factor: 3 })).toBe(9_000);
    expect(computeBackoff(10, { baseMs: 1_000, maxMs: 5_000 })).toBe(5_000);
  });

  it('treats negative or non-finite attempts as zero', () => {
    expect(computeBackoff(-3)).toBe(0);
    expect(computeBackoff(NaN)).toBe(0);
    expect(computeBackoff(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('exposes the pause-threshold the daemon uses', () => {
    expect(FAILURE_PAUSE_THRESHOLD).toBe(10);
  });

  it('caps gracefully even when Math.pow would overflow', () => {
    // Sanity: nothing returns Infinity even for very large attempts.
    for (let n = 1; n < 200; n++) {
      const v = computeBackoff(n);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(3_600_000);
    }
  });
});
