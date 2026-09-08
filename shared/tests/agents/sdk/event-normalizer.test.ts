import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../../src/runlog/classify-failure.js';
import {
  normalizeSdkPart,
  normalizeStopReason,
  addSdkUsage,
  buildSdkUsage,
  computeSdkCostUsd,
  pricingFromCatalogueEntry,
  type SdkLanguageModelUsage,
  type SdkModelPricing,
} from '../../../src/agents/sdk/event-normalizer.js';
import type { ParsedEvent } from '../../../src/runlog/types.js';

// A fabricated but realistic capture of one `ai` `fullStream`, shaped after
// the #415 spike's real run against playbooks/hn-commenter.md: run_start,
// two hn_search calls (trimmed from four for brevity), a drafts_create that
// fails gracefully (the decision doc's "tool errors return to the model"
// finding), and a run_finish. Framing parts (start, start-step, finish-step,
// text-start/end, tool-input-*) are interleaved exactly as the SDK emits
// them, to prove they're silently dropped rather than mistaken for content.
function recordedStreamParts(): unknown[] {
  return [
    { type: 'start' },
    { type: 'start-step', request: {}, warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', text: 'Looking for HN threads worth commenting on.' },
    { type: 'text-end', id: 't1' },
    { type: 'tool-input-start', id: 'call_1', toolName: 'run_start' },
    { type: 'tool-input-delta', id: 'call_1', delta: '{"campaignId":42}' },
    { type: 'tool-input-end', id: 'call_1' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'run_start', input: { campaignId: 42 } },
    {
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'run_start',
      input: { campaignId: 42 },
      output: { content: [{ type: 'text', text: '{"ok":true,"runId":901}' }], isError: false },
    },
    {
      type: 'finish-step',
      response: { id: 'resp_1', modelId: 'google/gemini-3.1-flash-lite' },
      usage: { inputTokens: 1200, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 0 } },
      finishReason: 'tool-calls',
      rawFinishReason: undefined,
      performance: {},
    },
    { type: 'start-step', request: {}, warnings: [] },
    { type: 'reasoning-delta', id: 'r1', text: 'Four candidate threads look promising.' },
    {
      type: 'tool-call',
      toolCallId: 'call_2',
      toolName: 'hn_search',
      input: { query: 'AI agents' },
    },
    {
      type: 'tool-result',
      toolCallId: 'call_2',
      toolName: 'hn_search',
      input: { query: 'AI agents' },
      output: {
        content: [{ type: 'text', text: '[{"id":123,"title":"Show HN"}]' }],
        isError: false,
      },
    },
    {
      type: 'finish-step',
      response: { id: 'resp_2', modelId: 'google/gemini-3.1-flash-lite' },
      usage: { inputTokens: 8600, outputTokens: 60, inputTokenDetails: { cacheReadTokens: 5200 } },
      finishReason: 'tool-calls',
      rawFinishReason: undefined,
      performance: {},
    },
    { type: 'start-step', request: {}, warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'call_3',
      toolName: 'drafts_create',
      input: { runId: 901, text: 'Nice project!' },
    },
    {
      type: 'tool-error',
      toolCallId: 'call_3',
      toolName: 'drafts_create',
      input: { runId: 901, text: 'Nice project!' },
      error: new Error('campaign profile is not in the structured format'),
    },
    {
      type: 'finish-step',
      response: { id: 'resp_3', modelId: 'google/gemini-3.1-flash-lite' },
      usage: { inputTokens: 9100, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 8800 } },
      finishReason: 'tool-calls',
      rawFinishReason: undefined,
      performance: {},
    },
    { type: 'start-step', request: {}, warnings: [] },
    { type: 'text-delta', id: 't2', text: 'The campaign profile needs fixing, so I stopped here.' },
    {
      type: 'tool-call',
      toolCallId: 'call_4',
      toolName: 'run_finish',
      input: { runId: 901, status: 'failed' },
    },
    {
      type: 'tool-result',
      toolCallId: 'call_4',
      toolName: 'run_finish',
      input: { runId: 901, status: 'failed' },
      output: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
    },
    {
      type: 'finish-step',
      response: { id: 'resp_4', modelId: 'google/gemini-3.1-flash-lite' },
      usage: { inputTokens: 9400, outputTokens: 90, inputTokenDetails: { cacheReadTokens: 9100 } },
      finishReason: 'stop',
      rawFinishReason: undefined,
      performance: {},
    },
    { type: 'finish', finishReason: 'stop', rawFinishReason: undefined, totalUsage: {} },
  ];
}

function normalizeAll(parts: unknown[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let seq = 0;
  for (const part of parts) {
    const produced = normalizeSdkPart(part, JSON.stringify(part), seq);
    for (const e of produced) events.push(e);
    seq += produced.length;
  }
  return events;
}

describe('normalizeSdkPart: readable timeline', () => {
  it('maps content parts to the expected kinds in order, and drops framing parts', () => {
    const events = normalizeAll(recordedStreamParts());
    expect(events.map((e) => e.kind)).toEqual([
      'assistant', // "Looking for HN threads..."
      'tool-call', // run_start
      'tool-result', // run_start result
      'thinking', // reasoning-delta
      'tool-call', // hn_search
      'tool-result', // hn_search result
      'tool-call', // drafts_create
      'tool-result', // drafts_create's tool-error, surfaced as an errored tool-result
      'assistant', // "The campaign profile needs fixing..."
      'tool-call', // run_finish
      'tool-result', // run_finish result
    ]);
  });

  it('assigns a strictly monotonic seq to every produced event', () => {
    const events = normalizeAll(recordedStreamParts());
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('carries the tool name and parsed input through on a tool-call', () => {
    const events = normalizeAll(recordedStreamParts());
    const call = events.find((e) => e.kind === 'tool-call' && e.seq === 4)!;
    expect(call.payload).toMatchObject({
      type: 'tool-call',
      name: 'hn_search',
      input: { query: 'AI agents' },
    });
  });

  it('renders a successful MCP tool-result from its content array, not the raw envelope', () => {
    const events = normalizeAll(recordedStreamParts());
    const result = events.find((e) => e.kind === 'tool-result' && e.seq === 2)!;
    expect(result.payload).toMatchObject({
      type: 'tool-result',
      text: '{"ok":true,"runId":901}',
      isError: false,
    });
  });

  it('surfaces a tool-error as an errored tool-result carrying the error message, not a run failure', () => {
    const events = normalizeAll(recordedStreamParts());
    const result = events.find((e) => e.kind === 'tool-result' && e.seq === 7)!;
    expect(result.payload).toMatchObject({
      type: 'tool-result',
      isError: true,
      text: 'campaign profile is not in the structured format',
    });
  });

  it('drops purely cosmetic parts (start, start-step, finish-step, tool-input-*, text-start/end)', () => {
    const cosmetic = [
      { type: 'start' },
      { type: 'start-step', request: {}, warnings: [] },
      { type: 'finish-step', response: {}, usage: {}, finishReason: 'stop' },
      { type: 'tool-input-start', id: 'x', toolName: 'y' },
      { type: 'tool-input-delta', id: 'x', delta: '{' },
      { type: 'tool-input-end', id: 'x' },
      { type: 'text-start', id: 't' },
      { type: 'text-end', id: 't' },
    ];
    for (const part of cosmetic) {
      expect(normalizeSdkPart(part, '', 0)).toEqual([]);
    }
  });
});

describe('normalizeSdkPart: provider error', () => {
  it('maps an in-band error part to a marker the classifier can key on', () => {
    const events = normalizeSdkPart({ type: 'error', error: new Error('upstream 503') }, '', 0);
    expect(events).toHaveLength(1);
    expect(events[0].raw).toContain('provider error');
    expect(events[0].raw).toContain('upstream 503');
  });
});

describe('normalizeStopReason', () => {
  it('is the only reason that reports success', () => {
    const usage = { inputTokens: 100, outputTokens: 20 };
    for (const reason of [
      'cancelled',
      'timeout',
      'error',
      'max_turn_requests',
      'refusal',
      'quota_exceeded',
    ] as const) {
      const [event] = normalizeStopReason(reason, usage, '', 0);
      expect(event.payload).toMatchObject({ type: 'result', success: false });
    }
    const [endTurn] = normalizeStopReason('end_turn', usage, '', 0);
    expect(endTurn.payload).toMatchObject({ type: 'result', success: true });
  });

  it('carries usage through onto the closing result event regardless of outcome', () => {
    const usage = {
      inputTokens: 9400,
      outputTokens: 90,
      cacheReadTokens: 9100,
      totalCostUsd: 0.0071,
    };
    const [event] = normalizeStopReason('max_turn_requests', usage, '', 0);
    expect(event.payload).toMatchObject({
      type: 'result',
      inputTokens: 9400,
      outputTokens: 90,
      cacheReadTokens: 9100,
      totalCostUsd: 0.0071,
    });
  });
});

describe('classifyFailure integration: SDK-specific reasons', () => {
  const usage = { inputTokens: 500, outputTokens: 20 };

  it('classifies a provider error as provider_error, never unknown', () => {
    const events = normalizeStopReason('error', usage, '', 0);
    expect(classifyFailure(events, 1)).toBe('provider_error');
  });

  it('classifies a client-aborted run as cancelled', () => {
    const events = normalizeStopReason('cancelled', usage, '', 0);
    expect(classifyFailure(events, 1)).toBe('cancelled');
  });

  it('classifies a step-ceiling exhaustion as step_limit_reached', () => {
    const events = normalizeStopReason('max_turn_requests', usage, '', 0);
    expect(classifyFailure(events, 1)).toBe('step_limit_reached');
  });

  it('classifies a timeout-aborted run as agent_timeout', () => {
    const events = normalizeStopReason('timeout', usage, '', 0);
    expect(classifyFailure(events, 1)).toBe('agent_timeout');
  });

  it('classifies a refusal as content_filtered', () => {
    const events = normalizeStopReason('refusal', usage, '', 0);
    expect(classifyFailure(events, 1)).toBe('content_filtered');
  });

  it('classifies a mid-run budget crossing as quota_exhausted (#419)', () => {
    const events = normalizeStopReason('quota_exceeded', usage, '', 0);
    expect(classifyFailure(events, 1)).toBe('quota_exhausted');
  });

  it('the six SDK markers stay distinct from each other', () => {
    const reasons = [
      'error',
      'cancelled',
      'max_turn_requests',
      'timeout',
      'refusal',
      'quota_exceeded',
    ] as const;
    const classified = reasons.map((r) => classifyFailure(normalizeStopReason(r, usage, '', 0), 1));
    expect(new Set(classified).size).toBe(reasons.length);
  });

  it('a provider error whose own message is an auth failure still classifies as auth_expired', () => {
    const events = normalizeStopReason('error', usage, 'HTTP 401 Unauthorized from upstream', 0);
    expect(classifyFailure(events, 1)).toBe('auth_expired');
  });
});

describe('usage + cost', () => {
  const pricing: SdkModelPricing = {
    // Roughly gemini-3.1-flash-lite's published per-token USD rates.
    inputPerToken: 0.00000015,
    outputPerToken: 0.0000006,
    cachedInputPerToken: 0.0000000375,
    cacheCreationPerToken: 0.00000015,
  };

  it('trusts the Gateway-reported cost when one is given', () => {
    const usage: SdkLanguageModelUsage = { inputTokens: 42767, outputTokens: 576 };
    const result = buildSdkUsage(usage, { reportedCostUsd: 0.0071, pricing });
    expect(result).toMatchObject({
      costUsd: 0.0071,
      costReported: true,
      inputTokens: 42767,
      outputTokens: 576,
    });
  });

  it('prices from the catalogue when the Gateway reports no cost, and cached input is cheaper than fresh', () => {
    const allFresh: SdkLanguageModelUsage = {
      inputTokens: 10000,
      outputTokens: 0,
      inputTokenDetails: { cacheReadTokens: 0 },
    };
    const mostlyCached: SdkLanguageModelUsage = {
      inputTokens: 10000,
      outputTokens: 0,
      inputTokenDetails: { cacheReadTokens: 9000 },
    };
    const freshCost = buildSdkUsage(allFresh, { pricing });
    const cachedCost = buildSdkUsage(mostlyCached, { pricing });
    expect(freshCost.costReported).toBe(false);
    expect(freshCost.costUsd).not.toBeNull();
    expect(cachedCost.costUsd).not.toBeNull();
    // Same total input tokens, but 9000 of them served from cache: strictly cheaper.
    expect(cachedCost.costUsd!).toBeLessThan(freshCost.costUsd!);
    // And matches the direct arithmetic: 1000 fresh + 9000 cached.
    const expected = Number(
      (1000 * pricing.inputPerToken + 9000 * pricing.cachedInputPerToken).toFixed(4),
    );
    expect(cachedCost.costUsd).toBe(expected);
  });

  it('records usage even on a call that failed after spending input tokens', () => {
    // Step 1 completed and spent tokens; step 2's request errored before any
    // response came back, so it contributes nothing - mirrors the real `ai`
    // behaviour (a mid-loop error skips the terminal `finish` part entirely).
    const step1: SdkLanguageModelUsage = {
      inputTokens: 1200,
      outputTokens: 40,
      inputTokenDetails: { cacheReadTokens: 0 },
    };
    const total = addSdkUsage(step1, undefined);
    const result = buildSdkUsage(total, { pricing });
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(40);
    expect(result.costUsd).not.toBeNull();
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('addSdkUsage sums step-level totals, including the cache-read subset', () => {
    const a: SdkLanguageModelUsage = {
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 20 },
    };
    const b: SdkLanguageModelUsage = {
      inputTokens: 200,
      outputTokens: 30,
      inputTokenDetails: { cacheReadTokens: 150 },
    };
    const sum = addSdkUsage(a, b);
    expect(sum).toMatchObject({
      inputTokens: 300,
      outputTokens: 40,
      inputTokenDetails: expect.objectContaining({ cacheReadTokens: 170 }),
    });
  });

  it('leaves cost null rather than guessing when neither a reported cost nor pricing is available', () => {
    const usage: SdkLanguageModelUsage = { inputTokens: 100, outputTokens: 10 };
    const result = buildSdkUsage(usage, {});
    expect(result).toMatchObject({ costUsd: null, costReported: false });
  });

  it('pricingFromCatalogueEntry falls back cache rates to the input rate when the catalogue omits them', () => {
    const parsed = pricingFromCatalogueEntry({
      pricing: { input: '0.000003', output: '0.000015' },
    });
    expect(parsed).toMatchObject({
      inputPerToken: 0.000003,
      cachedInputPerToken: 0.000003,
      cacheCreationPerToken: 0.000003,
    });
  });

  it('pricingFromCatalogueEntry returns undefined for a model with no catalogue pricing', () => {
    expect(pricingFromCatalogueEntry({ pricing: null })).toBeUndefined();
    expect(pricingFromCatalogueEntry(undefined)).toBeUndefined();
  });

  it('computeSdkCostUsd returns null without a pricing table, never a silent default', () => {
    expect(
      computeSdkCostUsd(
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
        undefined,
      ),
    ).toBeNull();
  });
});
