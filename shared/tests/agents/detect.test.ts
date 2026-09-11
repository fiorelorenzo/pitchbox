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

  it('reports the cloud runner from the credential as it is now, not as it was on the first call', async () => {
    // LOR-217: this answer used to be cached like a binary probe, so a
    // process that asked once before AI_GATEWAY_API_KEY was in place kept
    // reporting the managed runner unavailable for its whole life - and
    // every project that then resolved a default runner got a local slug the
    // cloud edition refuses to dispatch.
    const saved = process.env.AI_GATEWAY_API_KEY;
    try {
      delete process.env.AI_GATEWAY_API_KEY;
      expect((await detectRunner('cloud')).available).toBe(false);
      process.env.AI_GATEWAY_API_KEY = 'a-key';
      expect((await detectRunner('cloud')).available).toBe(true);
      delete process.env.AI_GATEWAY_API_KEY;
      expect((await detectRunner('cloud')).available).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = saved;
    }
  });
});
