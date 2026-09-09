// shared/tests/agents/sdk/runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { streamText } from 'ai';
import type { createGateway } from '@ai-sdk/gateway';
import { SdkRunner, __resetModelCatalogueCacheForTests } from '../../../src/agents/sdk/runner.js';
import type { ParsedEvent } from '../../../src/runlog/types.js';
import type { PitchboxToolSet } from '../../../src/agents/sdk/tools.js';

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// Fake `streamText`: every test supplies just the stream parts it cares
// about via an async generator, closing over the `abortSignal` the runner
// passes in so cancel/timeout tests can react to it exactly like the real
// AI SDK does - by ending the stream, never by throwing (docs/cloud-runner.md
// #415's "an aborted streamText does not throw" finding).
function fakeStreamText(parts: (signal: AbortSignal) => AsyncGenerator<unknown>) {
  return vi.fn((opts: { abortSignal?: AbortSignal }) => ({
    fullStream: parts(opts.abortSignal ?? new AbortController().signal),
  })) as unknown as typeof streamText;
}

async function* gen(...parts: unknown[]): AsyncGenerator<unknown> {
  for (const p of parts) yield p;
}

function fakeToolSet(): { fn: () => Promise<PitchboxToolSet>; closeCalls: number[] } {
  const closeCalls: number[] = [];
  const fn = async (): Promise<PitchboxToolSet> => ({
    tools: { a_tool: {} },
    close: async () => {
      closeCalls.push(closeCalls.length);
    },
  });
  return { fn, closeCalls };
}

function fakeGateway() {
  const getAvailableModels = vi.fn(async () => ({ models: [] }));
  const gateway = Object.assign(
    vi.fn((id: string) => ({ modelId: id }) as never),
    {
      getAvailableModels,
    },
  );
  return vi.fn(() => gateway) as unknown as typeof createGateway;
}

// A gateway whose catalogue prices exactly one model - the mid-stream
// budget tests need real per-token rates so `buildSdkUsage`'s computed
// `costUsd` is non-null and comparable against `budgetRemainingUsd`; the
// plain `fakeGateway()` above returns an empty catalogue on purpose (every
// existing test's cost stays null, since pricing isn't their concern).
function fakeGatewayWithPricing(modelId: string, pricing: { input: string; output: string }) {
  const getAvailableModels = vi.fn(async () => ({ models: [{ id: modelId, pricing }] }));
  const gateway = Object.assign(
    vi.fn((id: string) => ({ modelId: id }) as never),
    { getAvailableModels },
  );
  return vi.fn(() => gateway) as unknown as typeof createGateway;
}

function tmpLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'sdk-runner-test-'));
}

let logDir: string;

beforeEach(() => {
  logDir = tmpLogDir();
  process.env.AI_GATEWAY_API_KEY = 'test-key';
  // Otherwise a plain-catalogue test's cached empty model list (5-minute
  // TTL, process-lifetime by design) leaks into a later test that supplies
  // its own pricing via a different fake gateway.
  __resetModelCatalogueCacheForTests();
});

afterEach(() => {
  delete process.env.AI_GATEWAY_API_KEY;
  rmSync(logDir, { recursive: true, force: true });
  vi.useRealTimers();
});

const baseOpts = () => ({
  slug: 'hn-commenter',
  env: { PITCHBOX_RUN_ID: '7', PITCHBOX_CAMPAIGN_ID: '3' },
  cwd: '/tmp',
  timeoutMs: 60_000,
});

describe('SdkRunner', () => {
  it('rejects with a message naming the missing key when AI_GATEWAY_API_KEY is unset', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    const runner = new SdkRunner({ config: { model: 'google/gemini-3.1-flash-lite' }, logDir });
    const handle = runner.run({ ...baseOpts(), prompt: 'hi' });
    await expect(handle.result).rejects.toThrow(/AI_GATEWAY_API_KEY/);
  });

  it('rejects with a clear message when no model was resolved onto config.model', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const runner = new SdkRunner({ config: {}, logDir, createToolSetFn });
    const handle = runner.run({ ...baseOpts(), prompt: 'hi' });
    await expect(handle.result).rejects.toThrow(/resolved Gateway model/);
  });

  it('rejects when neither prompt nor playbookPath is given', async () => {
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn: fakeToolSet().fn,
      streamTextFn: fakeStreamText(() => gen()),
    });
    const handle = runner.run(baseOpts());
    await expect(handle.result).rejects.toThrow(/prompt or a playbookPath/);
  });

  it('runs a prompt-only turn to completion with attachMcp:false, skipping the tool set entirely', async () => {
    const createToolSetSpy = vi.fn(fakeToolSet().fn);
    const chunks: string[] = [];
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn: createToolSetSpy,
      streamTextFn: fakeStreamText(() =>
        gen(
          { type: 'text-delta', id: '1', text: 'Hello' },
          { type: 'text-delta', id: '1', text: ' there' },
          {
            type: 'finish-step',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
          },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5 },
          },
        ),
      ),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'suggest a reply',
      attachMcp: false,
      onTextChunk: (t) => chunks.push(t),
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    const res = await handle.result;
    expect(res.exitCode).toBe(0);
    expect(createToolSetSpy).not.toHaveBeenCalled();
    expect(chunks.join('')).toBe('Hello there');
    // One coalesced assistant event (not one per delta), plus the closing result event.
    const assistantEvents = events.filter((e) => e.kind === 'assistant');
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0].payload).toMatchObject({ type: 'assistant', text: 'Hello there' });
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.payload).toMatchObject({ type: 'result', success: true });
  });

  it('attaches the MCP tool set (bound to the run/campaign ids from opts.env) when attachMcp is not false', async () => {
    const createToolSetSpy = vi.fn(fakeToolSet().fn);
    const playbookPath = join(logDir, 'playbook.md');
    await writeFile(playbookPath, '# Playbook\nDo the thing.', 'utf8');
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn: createToolSetSpy,
      streamTextFn: fakeStreamText(() =>
        gen({
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ),
    });
    const handle = runner.run({ ...baseOpts(), playbookPath });
    await handle.result;
    expect(createToolSetSpy).toHaveBeenCalledWith({
      runId: 7,
      campaignId: 3,
      projectId: undefined,
    });
  });

  it('ends a cancelled run as cancelled, from the abort signal state rather than a thrown error', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    let resolveFirstChunk: () => void;
    const gotFirstChunk = new Promise<void>((resolve) => {
      resolveFirstChunk = resolve;
    });
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: fakeStreamText(function (signal) {
        return (async function* () {
          yield { type: 'text-delta', id: '1', text: 'partial' };
          // The real AI SDK ends the stream cleanly on abort - it does not
          // throw. Wait for the signal, then simply stop yielding, exactly
          // that behaviour.
          await waitForAbort(signal);
        })();
      }),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      onTextChunk: () => resolveFirstChunk(),
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    // Cancel only once the fake stream has actually started (deterministic:
    // wait on the runner's own callback, not a guessed real-time delay).
    await gotFirstChunk;
    handle.cancel();
    const res = await handle.result;
    expect(res.exitCode).toBe(1);
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.payload).toMatchObject({ type: 'result', success: false });
    expect(resultEvent?.raw).toMatch(/cancelled/);
  });

  it('ends a run that hits its own timeout as timed out, not hanging and not cancelled', async () => {
    vi.useFakeTimers();
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: fakeStreamText(function (signal) {
        // This fixture models a stream with no output at all until the
        // runner's own timeout aborts it.
        // eslint-disable-next-line require-yield
        return (async function* () {
          // Never yields again on its own - only the runner's timeout should
          // move this forward, by aborting the signal.
          await waitForAbort(signal);
        })();
      }),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      timeoutMs: 20,
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    const res = await handle.result;
    expect(res.exitCode).toBe(1);
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.raw).toMatch(/timed out/);
    expect(resultEvent?.raw).not.toMatch(/cancelled/);
  });

  it('turns an in-band provider error part into a failed run instead of an empty success', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: fakeStreamText(() =>
        gen({ type: 'error', error: new Error('502 Bad Gateway') }),
      ),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    const res = await handle.result;
    expect(res.exitCode).toBe(1);
    const providerErrorEvent = events.find(
      (e) => e.kind === 'unknown' && e.raw.includes('502 Bad Gateway'),
    );
    expect(providerErrorEvent).toBeDefined();
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.payload).toMatchObject({ type: 'result', success: false });
  });

  it('closes the MCP tool set exactly once even when the run ends in error', async () => {
    const { fn: createToolSetFn, closeCalls } = fakeToolSet();
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: fakeStreamText(() => gen({ type: 'error', error: new Error('boom') })),
    });
    const handle = runner.run({ ...baseOpts(), prompt: 'hi' });
    await handle.result;
    expect(closeCalls).toHaveLength(1);
  });

  it('reaching the step ceiling with more tool calls pending stops as max_turn_requests, not a crash', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      stepCeiling: 2,
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: fakeStreamText(() =>
        gen(
          {
            type: 'finish-step',
            finishReason: 'tool-calls',
            usage: { inputTokens: 5, outputTokens: 5, inputTokenDetails: {} },
          },
          {
            type: 'finish-step',
            finishReason: 'tool-calls',
            usage: { inputTokens: 5, outputTokens: 5, inputTokenDetails: {} },
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            totalUsage: { inputTokens: 10, outputTokens: 10 },
          },
        ),
      ),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    const res = await handle.result;
    // Not a runner-level failure: whether the playbook actually finished is
    // playbookContractError's job downstream, exactly as for AcpRunner.
    expect(res.exitCode).toBe(0);
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.raw).toMatch(/step limit/);
  });

  it('aborts mid-stream once its own accumulated cost crosses budgetRemainingUsd, ending as quota-exhausted with the earlier events kept', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGatewayWithPricing('google/gemini-3.1-flash-lite', {
        input: '0.000002',
        output: '0.000002',
      }),
      createToolSetFn,
      streamTextFn: fakeStreamText(function (signal) {
        return (async function* () {
          // Real content produced before the budget trips - this must
          // survive the abort, exactly like a real run's already-emitted
          // events stay in run_events (#419).
          yield { type: 'text-delta', id: '1', text: 'partial answer' };
          // 1000 input + 1000 output tokens at $0.000002/token = $0.004,
          // comfortably over the $0.001 budget below.
          yield {
            type: 'finish-step',
            finishReason: 'tool-calls',
            usage: { inputTokens: 1000, outputTokens: 1000, inputTokenDetails: {} },
          };
          // The real AI SDK ends the stream cleanly on abort rather than
          // throwing or yielding more (docs/cloud-runner.md #415) - the
          // runner itself is what calls `controller.abort()` here, once it
          // sees the finish-step above cross the budget.
          await waitForAbort(signal);
        })();
      }),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      budgetRemainingUsd: 0.001,
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    const res = await handle.result;
    expect(res.exitCode).toBe(1);
    expect(res.usage?.costUsd).toBeCloseTo(0.004, 4);
    const assistantEvent = events.find((e) => e.kind === 'assistant');
    expect(assistantEvent?.payload).toMatchObject({ type: 'assistant', text: 'partial answer' });
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.payload).toMatchObject({ type: 'result', success: false });
    expect(resultEvent?.raw).toMatch(/quota exhausted/);
    expect(resultEvent?.raw).toMatch(/monthly Gateway budget/);
  });

  it('does not abort a run that stays under its budgetRemainingUsd', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGatewayWithPricing('google/gemini-3.1-flash-lite', {
        input: '0.000002',
        output: '0.000002',
      }),
      createToolSetFn,
      streamTextFn: fakeStreamText(() =>
        gen(
          // Same $0.004 spend as the tripping test above, but the budget
          // here is $10 - nowhere near crossed.
          {
            type: 'finish-step',
            finishReason: 'stop',
            usage: { inputTokens: 1000, outputTokens: 1000, inputTokenDetails: {} },
          },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 1000, outputTokens: 1000 },
          },
        ),
      ),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      budgetRemainingUsd: 10,
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    const res = await handle.result;
    expect(res.exitCode).toBe(0);
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.payload).toMatchObject({ type: 'result', success: true });
  });

  it('never aborts on budget when the model has no catalogue pricing, since an unknown cost cannot be judged against it', async () => {
    const { fn: createToolSetFn } = fakeToolSet();
    const events: ParsedEvent[] = [];
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      // The plain fakeGateway() below returns an empty catalogue, so
      // buildSdkUsage's costUsd stays null however many tokens are reported.
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: fakeStreamText(() =>
        gen(
          {
            type: 'finish-step',
            finishReason: 'stop',
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, inputTokenDetails: {} },
          },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          },
        ),
      ),
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      attachMcp: false,
      // A budget so small it would trip instantly if cost were treated as 0
      // instead of unknown.
      budgetRemainingUsd: 0.0000001,
      onParsedEvents: (evs) => {
        events.push(...evs);
      },
    });
    const res = await handle.result;
    expect(res.exitCode).toBe(0);
    expect(res.usage?.costUsd).toBeNull();
    const resultEvent = events.find((e) => e.kind === 'result');
    expect(resultEvent?.payload).toMatchObject({ type: 'result', success: true });
  });

  it('attaches a directly-given tool set instead of the campaign MCP tool set when opts.tools is set', async () => {
    const createToolSetSpy = vi.fn(fakeToolSet().fn);
    let receivedTools: unknown;
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn: createToolSetSpy,
      streamTextFn: vi.fn((opts: { tools?: unknown; abortSignal?: AbortSignal }) => {
        receivedTools = opts.tools;
        return {
          fullStream: gen({
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 1 },
          }),
        };
      }) as unknown as typeof streamText,
    });
    const directTools = { read_thread: {} };
    const handle = runner.run({ ...baseOpts(), prompt: 'hi', tools: directTools });
    await handle.result;
    // The campaign MCP tool set is never created - a direct tool set wins
    // entirely, it does not merge with it.
    expect(createToolSetSpy).not.toHaveBeenCalled();
    expect(receivedTools).toBe(directTools);
  });

  it('passes no prepareStep to streamText when no toolLoopBudget is given, leaving campaign runs untouched', async () => {
    let capturedPrepareStep: unknown;
    const { fn: createToolSetFn } = fakeToolSet();
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      createToolSetFn,
      streamTextFn: vi.fn((opts: { prepareStep?: unknown }) => {
        capturedPrepareStep = opts.prepareStep;
        return {
          fullStream: gen({ type: 'finish', finishReason: 'stop', totalUsage: {} }),
        };
      }) as unknown as typeof streamText,
    });
    const handle = runner.run({ ...baseOpts(), prompt: 'hi', attachMcp: false });
    await handle.result;
    expect(capturedPrepareStep).toBeUndefined();
  });

  it('builds a prepareStep that forces toolChoice:none with a nudge once the step budget is hit', async () => {
    // Exercising the raw PrepareStepFunction the runner hands to streamText, not typed here.
    let capturedPrepareStep: any;
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      streamTextFn: vi.fn((opts: { prepareStep?: unknown }) => {
        capturedPrepareStep = opts.prepareStep;
        return { fullStream: gen({ type: 'finish', finishReason: 'stop', totalUsage: {} }) };
      }) as unknown as typeof streamText,
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      tools: {},
      toolLoopBudget: { maxSteps: 3, softBudgetMs: 1_000_000, tokenBudget: 1_000_000 },
    });
    await handle.result;
    // Steps 0 and 1 (of a 3-step budget, zero-based) are still free to call tools.
    expect(
      await capturedPrepareStep({ stepNumber: 0, steps: [], instructions: undefined }),
    ).toBeUndefined();
    expect(
      await capturedPrepareStep({
        stepNumber: 1,
        steps: [{ usage: { inputTokens: 10 } }],
        instructions: undefined,
      }),
    ).toBeUndefined();
    // Step 2 is the budget's last step (maxSteps - 1): forced text-only, with a
    // nudge explaining why, appended to whatever instructions already existed.
    const forced = await capturedPrepareStep({
      stepNumber: 2,
      steps: [{ usage: { inputTokens: 10 } }, { usage: { inputTokens: 10 } }],
      instructions: 'be concise',
    });
    expect(forced.toolChoice).toBe('none');
    expect(forced.instructions).toContain('be concise');
    expect(forced.instructions).toMatch(/budget/i);
  });

  it('forces toolChoice:none once the soft wall-clock budget elapses, independent of step count', async () => {
    vi.useFakeTimers();
    let capturedPrepareStep: any;
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      streamTextFn: vi.fn((opts: { prepareStep?: unknown }) => {
        capturedPrepareStep = opts.prepareStep;
        return { fullStream: gen({ type: 'finish', finishReason: 'stop', totalUsage: {} }) };
      }) as unknown as typeof streamText,
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      tools: {},
      toolLoopBudget: { maxSteps: 10, softBudgetMs: 5_000, tokenBudget: 1_000_000 },
    });
    await handle.result;
    // Well under the wall-clock budget: still free to call tools.
    expect(
      await capturedPrepareStep({ stepNumber: 0, steps: [], instructions: undefined }),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_001);
    const forced = await capturedPrepareStep({ stepNumber: 1, steps: [], instructions: undefined });
    expect(forced.toolChoice).toBe('none');
  });

  it('forces toolChoice:none once accumulated input tokens cross the token budget', async () => {
    let capturedPrepareStep: any;
    const runner = new SdkRunner({
      config: { model: 'google/gemini-3.1-flash-lite' },
      logDir,
      createGatewayFn: fakeGateway(),
      streamTextFn: vi.fn((opts: { prepareStep?: unknown }) => {
        capturedPrepareStep = opts.prepareStep;
        return { fullStream: gen({ type: 'finish', finishReason: 'stop', totalUsage: {} }) };
      }) as unknown as typeof streamText,
    });
    const handle = runner.run({
      ...baseOpts(),
      prompt: 'hi',
      tools: {},
      toolLoopBudget: { maxSteps: 10, softBudgetMs: 1_000_000, tokenBudget: 60_000 },
    });
    await handle.result;
    expect(
      await capturedPrepareStep({
        stepNumber: 1,
        steps: [{ usage: { inputTokens: 30_000 } }],
        instructions: undefined,
      }),
    ).toBeUndefined();
    const forced = await capturedPrepareStep({
      stepNumber: 2,
      steps: [{ usage: { inputTokens: 30_000 } }, { usage: { inputTokens: 30_001 } }],
      instructions: undefined,
    });
    expect(forced.toolChoice).toBe('none');
  });
});
