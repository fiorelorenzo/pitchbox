import { describe, it, expect } from 'vitest';
import { applyJitter } from '../../src/scheduler/jitter.js';

describe('applyJitter', () => {
  it('returns the base when p is 0', () => {
    expect(applyJitter(1000, 0)).toBe(1000);
  });

  it('returns the base when baseMs is 0 or negative', () => {
    expect(applyJitter(0)).toBe(0);
    expect(applyJitter(-50, 0.2)).toBe(-50);
  });

  it('keeps every sample within ±p of the base', () => {
    const base = 1000;
    const p = 0.1;
    for (let i = 0; i < 1000; i++) {
      const v = applyJitter(base, p);
      expect(v).toBeGreaterThanOrEqual(base * (1 - p));
      expect(v).toBeLessThanOrEqual(base * (1 + p));
    }
  });

  it('honours a larger jitter fraction', () => {
    const base = 5000;
    const p = 0.3;
    for (let i = 0; i < 1000; i++) {
      const v = applyJitter(base, p);
      expect(v).toBeGreaterThanOrEqual(base * (1 - p));
      expect(v).toBeLessThanOrEqual(base * (1 + p));
    }
  });

  it('clamps p above 1 to symmetric ±100% jitter', () => {
    const base = 1000;
    for (let i = 0; i < 200; i++) {
      const v = applyJitter(base, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(2000);
    }
  });

  it('has a mean within ~5% of the base across 1000 samples', () => {
    const base = 10_000;
    const p = 0.1;
    const n = 1000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += applyJitter(base, p);
    const mean = sum / n;
    // Uniform distribution → expected mean ≈ baseMs. 5% tolerance is generous
    // for n=1000 with ±10% jitter (stderr ≈ baseMs * p / sqrt(3*n) ≈ 0.18%).
    expect(mean).toBeGreaterThan(base * 0.95);
    expect(mean).toBeLessThan(base * 1.05);
  });

  it('defaults p to 0.1', () => {
    const base = 1000;
    for (let i = 0; i < 500; i++) {
      const v = applyJitter(base);
      expect(v).toBeGreaterThanOrEqual(900);
      expect(v).toBeLessThanOrEqual(1100);
    }
  });
});
