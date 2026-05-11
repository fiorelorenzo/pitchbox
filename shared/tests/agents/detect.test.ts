import { describe, it, expect, beforeEach } from 'vitest';
import { detectRunner, detectAllRunners, clearDetectionCache } from '../../src/agents/detect.js';

describe('runner detection', () => {
  beforeEach(() => {
    clearDetectionCache();
  });

  it('returns a result shape for every registered runner', async () => {
    const results = await detectAllRunners();
    for (const slug of ['claude-code', 'codex', 'opencode'] as const) {
      expect(results[slug]).toBeDefined();
      const r = results[slug];
      expect(typeof r.available).toBe('boolean');
      // Either we found a version+path, or we recorded an error.
      if (r.available) {
        expect(r.version).toMatch(/.+/);
        expect(r.path).toMatch(/.+/);
        expect(r.error).toBeNull();
      } else {
        expect(r.error).toMatch(/.+/);
      }
      expect(r.detectedAt).toMatch(/T/);
    }
  });

  it('caches results until clearDetectionCache is called', async () => {
    const first = await detectRunner('claude-code');
    const second = await detectRunner('claude-code');
    expect(second.detectedAt).toBe(first.detectedAt);
    clearDetectionCache();
    const third = await detectRunner('claude-code');
    expect(third.detectedAt).not.toBe(first.detectedAt);
  });
});
