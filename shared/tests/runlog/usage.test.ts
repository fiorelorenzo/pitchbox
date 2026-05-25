import { describe, it, expect } from 'vitest';
import {
  computeCostUsd,
  extractRunUsage,
  CLAUDE_SONNET_46_PRICING,
} from '../../src/runlog/usage.js';
import type { ParsedEvent } from '../../src/runlog/types.js';

describe('computeCostUsd', () => {
  it('computes 0 with no tokens', () => {
    expect(computeCostUsd({})).toBe(0);
  });

  it('computes cost using Sonnet 4.6 pricing', () => {
    // 1M input -> $3, 1M output -> $15, 1M cache-read -> $0.30, 1M cache-create -> $3.75
    const cost = computeCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 4);
  });

  it('respects custom pricing', () => {
    const cost = computeCostUsd(
      { inputTokens: 1_000_000 },
      { ...CLAUDE_SONNET_46_PRICING, inputPerM: 10 },
    );
    expect(cost).toBeCloseTo(10, 4);
  });
});

/**
 * Build a synthetic `result` ParsedEvent. extractRunUsage only inspects the
 * payload fields below, so we construct the shape directly rather than going
 * through a runner-specific parser.
 */
function resultEvent(
  seq: number,
  payload: {
    success?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalCostUsd?: number;
  },
): ParsedEvent {
  return {
    seq,
    kind: 'result',
    payload: { type: 'result', success: payload.success ?? true, ...payload },
    raw: '',
  };
}

describe('extractRunUsage', () => {
  it('returns null when no result event has usage', () => {
    const events: ParsedEvent[] = [];
    expect(extractRunUsage(events)).toBeNull();
  });

  it('extracts and computes cost from a result event with usage + cost', () => {
    const events: ParsedEvent[] = [
      resultEvent(0, {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        totalCostUsd: 0.1234,
      }),
    ];
    const usage = extractRunUsage(events);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(1000);
    expect(usage!.outputTokens).toBe(500);
    expect(usage!.cacheReadTokens).toBe(200);
    expect(usage!.cacheCreationTokens).toBe(100);
    expect(usage!.costReported).toBe(true);
    expect(usage!.costUsd).toBeCloseTo(0.1234, 4);
  });

  it('falls back to computed cost when totalCostUsd is missing', () => {
    const events: ParsedEvent[] = [
      resultEvent(0, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ];
    const usage = extractRunUsage(events);
    expect(usage).not.toBeNull();
    expect(usage!.costReported).toBe(false);
    expect(usage!.costUsd).toBeCloseTo(3, 4);
  });

  it('picks the last result event when multiple are present', () => {
    const events: ParsedEvent[] = [
      resultEvent(0, { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.0001 }),
      resultEvent(10, { inputTokens: 999, outputTokens: 999, totalCostUsd: 0.9999 }),
    ];
    const usage = extractRunUsage(events);
    expect(usage!.inputTokens).toBe(999);
    expect(usage!.costUsd).toBeCloseTo(0.9999, 4);
  });
});
