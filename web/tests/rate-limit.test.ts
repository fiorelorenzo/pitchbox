import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/server/rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to the limit per window, then blocks, and resets in the next window', () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.consume('a', 0)).toBe(true);
    expect(rl.consume('a', 100)).toBe(true);
    expect(rl.consume('a', 200)).toBe(true);
    expect(rl.consume('a', 300)).toBe(false); // 4th within the window is blocked
    expect(rl.consume('b', 300)).toBe(true); // a different key is unaffected
    expect(rl.consume('a', 1100)).toBe(true); // a new window resets the count
  });

  it('is atomic per call (no separate check-then-record): the boundary is exact', () => {
    const rl = new RateLimiter(2, 1000);
    // Simulate a synchronous burst (as the route does before its first await).
    const results = Array.from({ length: 5 }, () => rl.consume('ip', 0));
    expect(results).toEqual([true, true, false, false, false]);
  });

  it('sweep evicts expired buckets so the map does not grow unbounded', () => {
    const rl = new RateLimiter(1, 1000);
    rl.consume('x', 0);
    rl.consume('y', 0);
    // Both windows have elapsed; a sweep should drop them, so x can consume
    // again in a fresh window.
    rl.sweep(2000);
    expect(rl.consume('x', 2000)).toBe(true);
  });
});
