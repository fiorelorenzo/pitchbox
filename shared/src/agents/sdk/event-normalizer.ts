// shared/src/agents/sdk/event-normalizer.ts
//
// Normalizes the Vercel AI SDK's `streamText` stream (see #415,
// docs/cloud-runner.md's decision section) into the same ParsedEvent shape
// the ACP normalizer produces (shared/src/agents/acp/event-normalizer.ts is
// the working reference this mirrors), so the run view, the SSE feed and the
// dedup in dispatchRun (web/src/lib/server/runner.ts) don't know the SDK
// runner exists.
//
// Split into two halves, same as the ACP side:
//   - `normalizeSdkPart` turns one `ai` TextStreamPart into zero or more
//     ParsedEvents, driven by the runner's own seq counter exactly like
//     `normalizeAcpUpdate`.
//   - `normalizeStopReason` turns an already-classified outcome (the runner
//     is the only place that knows which AbortSignal fired or whether the
//     step ceiling was hit - see docs/cloud-runner.md's "aborted streamText
//     does not throw" finding) into the closing `result` event, exactly like
//     ACP's function of the same name.
// Usage/cost is "more than a mapping" per #418: a Gateway run can be any
// model, and cached input has to be priced separately from fresh input
// (~/projects/personal/canonry/packages/ai/src/usage.ts is the reference for
// that split). `buildSdkUsage`/`computeSdkCostUsd`/`pricingFromCatalogueEntry`
// do that math; they take already-resolved pricing rather than calling the
// Gateway themselves, so the runner (the only piece that holds the Gateway
// client) fetches `gateway.getAvailableModels()` and this module stays a
// pure function of its inputs.
import type { ParsedEvent } from '../../runlog/types.js';

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Usage + cost
// ---------------------------------------------------------------------------

/** Already-classified usage totals, ready to attach to a closing `result` event. */
export interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd?: number;
}

/**
 * Structurally the shape of `ai`'s `LanguageModelUsage` (streamText's
 * `result.totalUsage`, and each `finish-step` part's `usage`): `inputTokens`
 * is the TOTAL prompt tokens, of which `inputTokenDetails.cacheReadTokens`
 * and `.cacheWriteTokens` are subsets, not additions - the AI SDK's own type
 * says so and two measured Gateway calls confirm it (see canonry's
 * packages/ai/src/usage.ts, the reference for this split). Declared locally
 * instead of imported from `ai` so this module has no runtime dependency on
 * the SDK: the runner passes `result.totalUsage` (or its own step-accumulated
 * total) and the structural match is enough.
 */
export interface SdkLanguageModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/**
 * Add two step-level usage totals together. The runner needs this because a
 * mid-loop provider error closes the stream with an `error` part and no
 * top-level `finish` part (confirmed by reading `ai`'s streamText source: the
 * catch branch around the step-continuation call enqueues `error` then closes
 * the stream, skipping the `finish` part entirely) - so on that path there is
 * no single "total usage" object to read, only whatever `finish-step` parts
 * already went by. The runner accumulates those with this as it iterates the
 * stream, and hands the running total to `buildSdkUsage` whichever way the
 * run ends, so a call that failed after spending input tokens still records
 * what it spent instead of reporting zero.
 */
export function addSdkUsage(
  a: SdkLanguageModelUsage | undefined,
  b: SdkLanguageModelUsage | undefined,
): SdkLanguageModelUsage {
  const add = (x: number | undefined, y: number | undefined): number | undefined =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: add(a?.inputTokens, b?.inputTokens),
    outputTokens: add(a?.outputTokens, b?.outputTokens),
    inputTokenDetails: {
      noCacheTokens: add(a?.inputTokenDetails?.noCacheTokens, b?.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: add(
        a?.inputTokenDetails?.cacheReadTokens,
        b?.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: add(
        a?.inputTokenDetails?.cacheWriteTokens,
        b?.inputTokenDetails?.cacheWriteTokens,
      ),
    },
  };
}

/** Per-token USD rates, already resolved for one model. Cache rates are
 * never absent here: `pricingFromCatalogueEntry` fills them in from the plain
 * input rate when the catalogue doesn't carry a discount, the same fallback
 * direction canonry's `computeCost` uses and for the same reason - a provider
 * that doesn't discount cache reads bills them at the input rate, not free. */
export interface SdkModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cachedInputPerToken: number;
  cacheCreationPerToken: number;
}

/** The pricing shape `@ai-sdk/gateway`'s `GatewayLanguageModelEntry.pricing`
 * carries: per-token USD as strings, cache fields only present for
 * providers/models that support prompt caching. */
export interface GatewayCataloguePricing {
  input: string;
  output: string;
  cachedInputTokens?: string;
  cacheCreationInputTokens?: string;
}

/**
 * Parse one Gateway model catalogue entry (`gateway.getAvailableModels()`'s
 * `models[i]`) into `SdkModelPricing`. Returns `undefined` when the catalogue
 * has no pricing for the model (some entries carry `pricing: null`), so the
 * caller falls back to the run's self-reported cost or leaves it null -
 * never a hardcoded default, for the same reason `resolvePricingForRunner`
 * in runlog/usage.ts refuses to guess for an unknown model.
 */
export function pricingFromCatalogueEntry(
  entry: { pricing?: GatewayCataloguePricing | null } | null | undefined,
): SdkModelPricing | undefined {
  const p = entry?.pricing;
  if (!p) return undefined;
  const inputPerToken = Number(p.input);
  const outputPerToken = Number(p.output);
  if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) return undefined;
  const cachedInputPerToken =
    p.cachedInputTokens != null ? Number(p.cachedInputTokens) : inputPerToken;
  const cacheCreationPerToken =
    p.cacheCreationInputTokens != null ? Number(p.cacheCreationInputTokens) : inputPerToken;
  return {
    inputPerToken,
    outputPerToken,
    cachedInputPerToken: Number.isFinite(cachedInputPerToken) ? cachedInputPerToken : inputPerToken,
    cacheCreationPerToken: Number.isFinite(cacheCreationPerToken)
      ? cacheCreationPerToken
      : inputPerToken,
  };
}

/**
 * Price a token split. `inputTokens` is the TOTAL (matches `ai`'s own usage
 * semantics); `cacheReadTokens`/`cacheCreationTokens` are subsets of it, so
 * "fresh" input is whatever is left over once both are subtracted, clamped so
 * a provider reporting more cached tokens than its own total can't produce a
 * negative bill (same clamp as canonry's `splitInput`).
 */
export function computeSdkCostUsd(
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  },
  pricing: SdkModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  const cacheRead = Math.min(Math.max(tokens.cacheReadTokens, 0), tokens.inputTokens);
  const cacheWrite = Math.min(
    Math.max(tokens.cacheCreationTokens, 0),
    tokens.inputTokens - cacheRead,
  );
  const fresh = tokens.inputTokens - cacheRead - cacheWrite;
  const cost =
    fresh * pricing.inputPerToken +
    cacheRead * pricing.cachedInputPerToken +
    cacheWrite * pricing.cacheCreationPerToken +
    tokens.outputTokens * pricing.outputPerToken;
  return Number(cost.toFixed(4));
}

/** Same shape as `shared/src/runlog/usage.ts`'s `RunUsage`, and as
 * `AgentRunResult.usage` (shared/src/agents/base.ts) - drops straight in. */
export interface RunUsageResult {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null when not self-reported and pricing for the run's model is unknown. */
  costUsd: number | null;
  /** True when `opts.reportedCostUsd` came from the Gateway; false when computed locally. */
  costReported: boolean;
}

/**
 * Turn accumulated SDK usage into the run's final token + cost figures.
 * Keeps the existing self-reported-cost path honest: when the caller has a
 * Gateway-reported cost (from `getGenerationInfo` or provider metadata),
 * `opts.reportedCostUsd` wins outright, same as ACP's `total_cost_usd`.
 * Otherwise this prices from the model's own catalogue entry rather than
 * Claude's hardcoded table (the Gateway can front any model), and returns
 * `null` only when neither a reported cost nor a catalogue entry exists.
 */
export function buildSdkUsage(
  usage: SdkLanguageModelUsage,
  opts: { reportedCostUsd?: number; pricing?: SdkModelPricing } = {},
): RunUsageResult {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const tokens = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
  const reported = typeof opts.reportedCostUsd === 'number';
  const costUsd = reported
    ? Number(opts.reportedCostUsd!.toFixed(4))
    : computeSdkCostUsd(tokens, opts.pricing);
  return { ...tokens, costUsd, costReported: reported };
}

// ---------------------------------------------------------------------------
// Stream part -> ParsedEvent
// ---------------------------------------------------------------------------

/** MCP `CallToolResult.content` is an array of `{type:'text', text}` blocks
 * (plus image/resource variants we don't render inline) - the exact shape
 * ACP's `joinContent` already handles for the same reason: it's the same MCP
 * protocol on both sides of the tool boundary. */
function extractMcpText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = asRecord(part);
      if (!p) return '';
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractToolResultOutput(output: unknown): { text: string; isError: boolean } {
  const o = asRecord(output);
  if (!o) {
    if (typeof output === 'string') return { text: output, isError: false };
    if (output == null) return { text: '', isError: false };
    try {
      return { text: JSON.stringify(output), isError: false };
    } catch {
      return { text: String(output), isError: false };
    }
  }
  // MCP tools carry their own `isError` inside the CallToolResult (the
  // decision doc's finding: "a tool that fails returns its error to the
  // model instead of killing the loop" - this is that path, not a stream
  // failure). Prefer the rendered `content` text; fall back to the whole
  // envelope as JSON so nothing is silently dropped.
  const isError = o.isError === true;
  if (Array.isArray(o.content)) {
    const joined = extractMcpText(o.content);
    if (joined) return { text: joined, isError };
  }
  try {
    return { text: JSON.stringify(o), isError };
  } catch {
    return { text: '', isError };
  }
}

/**
 * Normalize one `ai` `TextStreamPart` (from `streamText`'s `fullStream`) into
 * zero or more `ParsedEvent`s. `seq` is supplied by the caller and advances
 * exactly like `normalizeAcpUpdate`'s: the runner owns one counter across the
 * whole run and increments it by however many events this call produced.
 *
 * `part` is untyped on purpose (mirrors `normalizeAcpUpdate(update: unknown, ...)`):
 * this module carries no runtime dependency on the `ai` package, only a
 * structural expectation of `{ type: string, ... }`.
 *
 * Framing-only parts (`start`, `start-step`, `finish-step`, `text-start`,
 * `text-end`, `reasoning-start`, `reasoning-end`, `tool-input-*`, `source`,
 * `file`, `reasoning-file`, `custom`, `raw`, `tool-output-denied`,
 * `tool-approval-*`) return `[]` - nothing for the run log to render, same
 * "cosmetic, skip it" precedent as ACP's `tool_call_update` branch.
 *
 * The three terminal part types (`finish`, `abort`, `error`) are NOT handled
 * here: an aborted or errored `fullStream` never throws (docs/cloud-runner.md
 * #415), and only the runner knows *why* it ended - which AbortSignal fired,
 * whether the step ceiling was hit - so the runner detects those three types
 * in its own loop and calls `normalizeStopReason` with an already-classified
 * reason, exactly like ACP's `session/prompt` response never goes through
 * `normalizeAcpUpdate` either. `error` still gets a narrow defensive mapping
 * below so a build that routes every part through this function uniformly
 * still gives the classifier a "provider error" marker instead of nothing.
 */
export function normalizeSdkPart(part: unknown, raw: string, seq: number): ParsedEvent[] {
  const p = asRecord(part);
  const type = typeof p?.type === 'string' ? p.type : undefined;
  if (!p || !type) return [];

  switch (type) {
    case 'text-delta': {
      const text = typeof p.text === 'string' ? p.text : '';
      if (!text) return [];
      return [{ seq, kind: 'assistant', payload: { type: 'assistant', text }, raw }];
    }
    case 'reasoning-delta': {
      const text = typeof p.text === 'string' ? p.text : '';
      if (!text) return [];
      return [{ seq, kind: 'thinking', payload: { type: 'thinking', text }, raw }];
    }
    case 'tool-call': {
      const id = typeof p.toolCallId === 'string' ? p.toolCallId : undefined;
      const name = typeof p.toolName === 'string' ? p.toolName : 'tool';
      const input = asRecord(p.input) ?? {};
      return [{ seq, kind: 'tool-call', payload: { type: 'tool-call', id, name, input }, raw }];
    }
    case 'tool-result': {
      const toolUseId = typeof p.toolCallId === 'string' ? p.toolCallId : undefined;
      const { text, isError } = extractToolResultOutput(p.output);
      return [
        {
          seq,
          kind: 'tool-result',
          payload: { type: 'tool-result', raw: p.output, text, isError, toolUseId },
          raw,
        },
      ];
    }
    case 'tool-error': {
      // Tool execution itself threw (transport failure calling the MCP
      // server, say), distinct from a tool that ran and returned
      // isError:true - both end up as an errored tool-result, which is the
      // shape the run log already knows how to render.
      const toolUseId = typeof p.toolCallId === 'string' ? p.toolCallId : undefined;
      const text = errorMessage(p.error);
      return [
        {
          seq,
          kind: 'tool-result',
          payload: { type: 'tool-result', raw: p.error, text, isError: true, toolUseId },
          raw,
        },
      ];
    }
    case 'error': {
      const marker = `provider error: ${errorMessage(p.error)}`;
      return [
        {
          seq,
          kind: 'unknown',
          payload: { type: 'unknown', eventType: 'error', raw: marker },
          raw: raw ? `${marker}\n${raw}` : marker,
        },
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Stop reason -> closing `result` event
// ---------------------------------------------------------------------------

/**
 * Already-classified run outcome, decided by the runner from facts only it
 * has: which AbortSignal fired (`cancelled` vs `timeout` vs its own
 * mid-stream budget check, `quota_exceeded`), whether an `error` part closed
 * the stream, whether the terminal `finish` part's finishReason came back
 * `tool-calls` with no further step (the step ceiling cut the loop off
 * before the model could act on it - #415's `stopWhen(stepCountIs(n))`), or
 * content-filter/refusal. Mirrors ACP's `AcpStopReasonKind`.
 */
export type SdkStopReasonKind =
  | 'end_turn'
  | 'cancelled'
  | 'timeout'
  | 'error'
  | 'max_turn_requests'
  | 'refusal'
  | 'quota_exceeded';

// Marker text embedded in the closing event's `raw`/`text` so classifyFailure
// (shared/src/runlog/classify-failure.ts) has something distinctive to match
// beyond "unknown" for every non-success reason.
const STOP_REASON_TEXT: Partial<Record<SdkStopReasonKind, string>> = {
  cancelled: 'run cancelled: aborted by the client',
  timeout: 'run timed out: exceeded its time limit and was aborted',
  error: 'run failed: a provider error ended the run',
  max_turn_requests: 'run stopped: step limit reached before the agent finished',
  refusal: 'run stopped: the model refused to continue',
  // Contains "quota" on purpose - classifyFailure's QUOTA_PATTERNS matches
  // that substring and maps it to the `quota_exhausted` failure reason with
  // no changes needed there (#419: the runner aborts once its own
  // accumulated cost would push the org over its remaining monthly budget).
  quota_exceeded:
    'run stopped: quota exhausted, the organization crossed its monthly Gateway budget mid-run',
};

/**
 * Synthesize the closing `result` ParsedEvent for an SDK run, exactly like
 * ACP's `normalizeStopReason`: `success` is true only for a natural
 * `end_turn`, so an aborted stream (which never throws, per #415) or a
 * step-ceiling exhaustion never reads as success just because nothing threw.
 *
 * The marker text is embedded into the event's own `raw`/`payload.text`
 * regardless of what `raw` the caller passes in (ACP's real call site passes
 * `''`), so classifyFailure has a reason-specific substring to match even
 * when nothing else about the run is distinctive - a step-limit run has no
 * "error" anywhere in its transcript otherwise.
 */
export function normalizeStopReason(
  reason: SdkStopReasonKind | string,
  usage: SdkUsage | undefined,
  raw: string,
  seq: number,
): ParsedEvent[] {
  const success = reason === 'end_turn';
  const marker = STOP_REASON_TEXT[reason as SdkStopReasonKind];
  const combinedRaw = marker ? (raw ? `${marker}\n${raw}` : marker) : raw;
  return [
    {
      seq,
      kind: 'result',
      payload: {
        type: 'result',
        success,
        text: marker,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheCreationTokens: usage?.cacheCreationTokens,
        totalCostUsd: usage?.totalCostUsd,
      },
      raw: combinedRaw,
    },
  ];
}
