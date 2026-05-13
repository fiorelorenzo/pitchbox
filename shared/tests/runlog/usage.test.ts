import { describe, it, expect } from 'vitest';
import {
  computeCostUsd,
  extractRunUsage,
  CLAUDE_SONNET_46_PRICING,
} from '../../src/runlog/usage.js';
import { parseClaudeCodeLine } from '../../src/runlog/parsers/claude-code.js';
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

describe('extractRunUsage', () => {
  it('returns null when no result event has usage', () => {
    const events: ParsedEvent[] = [];
    expect(extractRunUsage(events)).toBeNull();
  });

  it('extracts and computes cost from parsed stream-json result line', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.1234,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    });
    const events = parseClaudeCodeLine(line, 0);
    const usage = extractRunUsage(events);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(1000);
    expect(usage!.outputTokens).toBe(500);
    expect(usage!.cacheReadTokens).toBe(200);
    expect(usage!.cacheCreationTokens).toBe(100);
    expect(usage!.costReported).toBe(true);
    expect(usage!.costUsd).toBeCloseTo(0.1234, 4);
  });

  it('falls back to computed cost when total_cost_usd is missing', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    const events = parseClaudeCodeLine(line, 0);
    const usage = extractRunUsage(events);
    expect(usage).not.toBeNull();
    expect(usage!.costReported).toBe(false);
    expect(usage!.costUsd).toBeCloseTo(3, 4);
  });

  it('picks the last result event when multiple are present', () => {
    const events = [
      ...parseClaudeCodeLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0.0001,
        }),
        0,
      ),
      ...parseClaudeCodeLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 999, output_tokens: 999 },
          total_cost_usd: 0.9999,
        }),
        10,
      ),
    ];
    const usage = extractRunUsage(events);
    expect(usage!.inputTokens).toBe(999);
    expect(usage!.costUsd).toBeCloseTo(0.9999, 4);
  });
});
