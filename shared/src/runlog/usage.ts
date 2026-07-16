/**
 * Token usage + USD cost extraction for runner output.
 *
 * Claude Code `stream-json` emits one or more `result` events at the end of a
 * run, each with a `usage` block ({ input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens }) and an optional
 * `total_cost_usd`. We pick the LAST `result` event's usage (the dedup logic
 * in web/src/lib/server/runner.ts already keeps only the last one) and either
 * trust `totalCostUsd` if reported, or compute it from the token columns using
 * a price table resolved from the run's actual configured backend + model
 * (`resolvePricingForRunner`) - never a single hardcoded default, since a
 * campaign can be configured to run claude-opus-4-7, claude-haiku-4-5, or an
 * entirely different backend (codex/gemini/qwen/...).
 *
 * Known Claude Code model prices are the Anthropic published rates as of
 * 2026-05 (per 1M tokens: input / output / cache-read / cache-creation-5m):
 *   - claude-sonnet-4-6 (CLI default): $3.00  / $15.00 / $0.30 / $3.75
 *   - claude-opus-4-7:                 $15.00 / $75.00 / $1.50 / $18.75
 *   - claude-haiku-4-5:                $0.80  / $4.00  / $0.08 / $1.00
 *
 * For any backend/model combination we don't have a price table for, prefer
 * the runner-reported `totalCostUsd`; when that isn't reported either, the
 * cost is left `null` rather than silently priced at the Sonnet rate.
 */

import type { ParsedEvent } from './types.js';

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null when the cost couldn't be trusted: not self-reported, and pricing for the run's model/backend is unknown. */
  costUsd: number | null;
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

export const CLAUDE_OPUS_47_PRICING: RunnerPricing = {
  inputPerM: 15.0,
  outputPerM: 75.0,
  cacheReadPerM: 1.5,
  cacheCreationPerM: 18.75,
};

export const CLAUDE_HAIKU_45_PRICING: RunnerPricing = {
  inputPerM: 0.8,
  outputPerM: 4.0,
  cacheReadPerM: 0.08,
  cacheCreationPerM: 1.0,
};

// Keyed by the exact `model` string a campaign's runner config can hold (see
// the claude-code entry in shared/src/agents/meta.ts's RUNNER_CONFIG_SCHEMA).
// A model not in this table (custom/free-typed, since that field allows
// custom values) has unknown pricing - see resolvePricingForRunner.
const CLAUDE_MODEL_PRICING: Record<string, RunnerPricing> = {
  'claude-sonnet-4-6': CLAUDE_SONNET_46_PRICING,
  'claude-opus-4-7': CLAUDE_OPUS_47_PRICING,
  'claude-haiku-4-5': CLAUDE_HAIKU_45_PRICING,
};

/**
 * Resolve the pricing table to use for a run, from its actual configured
 * runner slug + model, instead of assuming Sonnet for everyone.
 *
 * - `claude-code` with no model configured falls back to Sonnet 4.6, since
 *   that's the underlying CLI's own default model.
 * - `claude-code` with a known model uses that model's own pricing.
 * - `claude-code` with an unrecognized (custom) model, or any other backend
 *   (codex/gemini/copilot/opencode/qwen-code/cloud) - pricing is unknown, so
 *   this returns `undefined` and callers must fall back to the runner's own
 *   reported `totalCostUsd`, or leave the cost null.
 */
export function resolvePricingForRunner(
  slug: string,
  model: string | undefined,
): RunnerPricing | undefined {
  if (slug !== 'claude-code') return undefined;
  if (!model) return CLAUDE_SONNET_46_PRICING;
  return CLAUDE_MODEL_PRICING[model];
}

export function computeCostUsd(
  tokens: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  pricing: RunnerPricing | undefined,
): number | null {
  if (!pricing) return null;
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
 *
 * `pricing` defaults to Sonnet 4.6 for backward compatibility with callers
 * that don't know the run's actual model/backend; callers that do (e.g. the
 * ACP runner) should resolve it via `resolvePricingForRunner` and pass it
 * explicitly - passing `undefined` leaves an uncomputed cost as `null`
 * instead of defaulting to Sonnet.
 */
export function extractRunUsage(
  events: Iterable<ParsedEvent>,
  pricing: RunnerPricing | undefined = CLAUDE_SONNET_46_PRICING,
): RunUsage | null {
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
  const costUsd = reported
    ? Number(last.totalCostUsd!.toFixed(4))
    : computeCostUsd(tokens, pricing);
  return {
    ...tokens,
    costUsd,
    costReported: reported,
  };
}
