// shared/tests/agents/sdk/runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { streamText } from 'ai';
import type { createGateway } from '@ai-sdk/gateway';
import { SdkRunner } from '../../../src/agents/sdk/runner.js';
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

function tmpLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'sdk-runner-test-'));
}

let logDir: string;

beforeEach(() => {
  logDir = tmpLogDir();
  process.env.AI_GATEWAY_API_KEY = 'test-key';
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
});
