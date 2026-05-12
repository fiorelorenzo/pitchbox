/**
 * Token usage + USD cost extraction for runner output.
 *
 * Claude Code `stream-json` emits one or more `result` events at the end of a
 * run, each with a `usage` block ({ input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens }) and an optional
 * `total_cost_usd`. We pick the LAST `result` event's usage (the dedup logic
 * in web/src/lib/server/runner.ts already keeps only the last one) and either
 * trust `totalCostUsd` if reported, or compute it from the token columns using
 * the price table below.
 *
 * Assumed model: Claude Sonnet 4.6 (the default Pitchbox runner). Prices are
 * the Anthropic published rates as of 2026-05:
 *   - input:               $3.00 / 1M tokens
 *   - output:              $15.00 / 1M tokens
 *   - cache read:          $0.30 / 1M tokens
 *   - cache creation (5m): $3.75 / 1M tokens
 *
 * When other models are used, prefer the runner-reported `totalCostUsd`.
 */

import type { ParsedEvent } from './types.js';

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** True when the cost came from the runner's `total_cost_usd`; false when computed locally. */
  costReported: boolean;
}

export interface RunnerPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheCreationPerM: number;
}

export const CLAUDE_SONNET_46_PRICING: RunnerPricing = {
  inputPerM: 3.0,
  outputPerM: 15.0,
  cacheReadPerM: 0.3,
  cacheCreationPerM: 3.75,
};

export function computeCostUsd(
  tokens: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  pricing: RunnerPricing = CLAUDE_SONNET_46_PRICING,
): number {
  const inp = tokens.inputTokens ?? 0;
  const out = tokens.outputTokens ?? 0;
  const cr = tokens.cacheReadTokens ?? 0;
  const cc = tokens.cacheCreationTokens ?? 0;
  const cost =
    (inp * pricing.inputPerM) / 1_000_000 +
    (out * pricing.outputPerM) / 1_000_000 +
    (cr * pricing.cacheReadPerM) / 1_000_000 +
    (cc * pricing.cacheCreationPerM) / 1_000_000;
  return Number(cost.toFixed(4));
}

/**
 * Scan a list of parsed events and extract aggregate usage + cost.
 * Returns `null` if no result event with usage data was found.
 */
export function extractRunUsage(events: Iterable<ParsedEvent>): RunUsage | null {
  let last: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalCostUsd?: number;
  } | null = null;
  for (const e of events) {
    if (e.kind === 'result' && e.payload && e.payload.type === 'result') {
      const p = e.payload;
      // Keep the latest result with any usable usage info.
      if (
        p.inputTokens != null ||
        p.outputTokens != null ||
        p.cacheReadTokens != null ||
        p.cacheCreationTokens != null ||
        p.totalCostUsd != null
      ) {
        last = p;
      }
    }
  }
  if (!last) return null;
  const tokens = {
    inputTokens: last.inputTokens ?? 0,
    outputTokens: last.outputTokens ?? 0,
    cacheReadTokens: last.cacheReadTokens ?? 0,
    cacheCreationTokens: last.cacheCreationTokens ?? 0,
  };
  const reported = typeof last.totalCostUsd === 'number';
  const costUsd = reported ? Number(last.totalCostUsd!.toFixed(4)) : computeCostUsd(tokens);
  return {
    ...tokens,
    costUsd,
    costReported: reported,
  };
}
