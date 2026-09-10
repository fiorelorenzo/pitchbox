// shared/tests/assist/loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildAssistToolSet } from '../../src/assist/loop.js';
import type { AssistTool, AssistToolAnswer, AssistToolContext } from '../../src/assist/tools.js';
import { ASSIST_TOOL_TIMEOUT_MS, ASSIST_VISION_TIMEOUT_MS } from '../../src/assist/budget.js';

/**
 * What this file defends: the one enforcement point `buildAssistToolSet`
 * exists for (docs/design/in-page-agent.md section 2) - a cancelled
 * suggestion never starts a new handler, a hanging handler never blocks the
 * loop past its ceiling, `look_at_image` gets the longer vision ceiling, an
 * in-flight handler is told to stop rather than merely ignored, and nothing
 * in this wrapper accidentally serializes tools the model called together.
 * The seven real handlers (#567) are exercised by their own test file -
 * every tool fixture here is a fake, on purpose.
 *
 * `execute`'s cancellation source is `ai`'s own second argument
 * (`options.abortSignal`) - exactly what `SdkRunner` hands every tool call
 * once `handle.cancel()` trips its `controller.abort()` - so these tests
 * drive it directly rather than a bespoke signal.
 */

function fakeCtx(): AssistToolContext {
  return {
    db: {} as AssistToolContext['db'],
    orgId: 1,
    observedTarget: null,
    operator: null,
  };
}

function execOpts(signal?: AbortSignal) {
  return { toolCallId: 't1', messages: [], context: undefined, abortSignal: signal };
}

function makeTool<T>(
  name: string,
  handler: (
    ctx: AssistToolContext,
    args: Record<string, never>,
    signal?: AbortSignal,
  ) => Promise<AssistToolAnswer<T>>,
): AssistTool<Record<string, never>, T> {
  return { name, description: name, schema: {}, handler };
}

/** A handler that never answers on its own - only the wrapper's own ceiling
 * or an abort can end it. */
function hangingTool<T>(name: string): AssistTool<Record<string, never>, T> {
  // shared's tsconfig targets a lib without `Promise.withResolvers` (see
  // loop.ts's own comment) - the executor form is the one that typechecks.
  return makeTool<T>(name, () => new Promise<AssistToolAnswer<T>>(() => {}));
}

describe('buildAssistToolSet', () => {
  it('never calls the handler when the execution signal is already aborted', async () => {
    const handlerSpy = vi.fn(async () => ({ ok: true as const, data: 'x' }));
    const toolSet = buildAssistToolSet([makeTool('read_thread', handlerSpy)], fakeCtx());
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const result = await toolSet.read_thread.execute!({}, execOpts(alreadyAborted.signal));
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('stops waiting on a handler that exceeds its per-tool timeout, without waiting for it to resolve', async () => {
    vi.useFakeTimers();
    try {
      const toolSet = buildAssistToolSet([hangingTool('author_history')], fakeCtx());
      const resultPromise = toolSet.author_history.execute!({}, execOpts());
      await vi.advanceTimersByTimeAsync(ASSIST_TOOL_TIMEOUT_MS + 1);
      const result = await resultPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/time budget/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives look_at_image the longer vision ceiling instead of the standard 4s tool ceiling', async () => {
    vi.useFakeTimers();
    try {
      const toolSet = buildAssistToolSet(
        [hangingTool('look_at_image'), hangingTool('operator_voice')],
        fakeCtx(),
      );
      const visionPromise = toolSet.look_at_image.execute!({}, execOpts());
      const voicePromise = toolSet.operator_voice.execute!({}, execOpts());

      await vi.advanceTimersByTimeAsync(ASSIST_TOOL_TIMEOUT_MS + 1);
      // The standard-ceiling tool has already timed out...
      const voiceResult = await voicePromise;
      expect(voiceResult.ok).toBe(false);
      // ...but look_at_image's own, longer ceiling has not been reached yet.
      let visionSettled = false;
      void visionPromise.then(() => {
        visionSettled = true;
      });
      await Promise.resolve();
      expect(visionSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(ASSIST_VISION_TIMEOUT_MS - ASSIST_TOOL_TIMEOUT_MS + 1);
      const visionResult = await visionPromise;
      expect(visionResult.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('threads the execution abort signal into the handler so an in-flight tool can stop early on cancel', async () => {
    const outer = new AbortController();
    let handlerSawAbort = false;
    const toolSet = buildAssistToolSet(
      [
        makeTool<never>('look_at_image', (_ctx, _args, signal) => {
          return new Promise<AssistToolAnswer<never>>((resolve) => {
            signal?.addEventListener('abort', () => {
              handlerSawAbort = true;
              resolve({ ok: false, reason: 'aborted mid-flight' });
            });
          });
        }),
      ],
      fakeCtx(),
    );
    const resultPromise = toolSet.look_at_image.execute!({}, execOpts(outer.signal));
    outer.abort();
    const result = await resultPromise;
    // Whichever settles the race, the handler must have actually observed
    // the abort (proving the signal reached the in-flight Gateway call,
    // not just that the wrapper stopped waiting on it) and the loop must
    // still get back a refusal rather than hang.
    expect(handlerSawAbort).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('runs independent tools concurrently rather than serializing them', async () => {
    vi.useFakeTimers();
    try {
      const DELAY_MS = 40;
      let concurrent = 0;
      let peakConcurrent = 0;
      const delayed = (label: string): AssistTool<Record<string, never>, string> =>
        makeTool(label, async () => {
          concurrent += 1;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS));
          concurrent -= 1;
          return { ok: true, data: label };
        });
      const toolSet = buildAssistToolSet(
        [delayed('read_thread'), delayed('author_history')],
        fakeCtx(),
      );
      const resultsPromise = Promise.all([
        toolSet.read_thread.execute!({}, execOpts()),
        toolSet.author_history.execute!({}, execOpts()),
      ]);
      await vi.advanceTimersByTimeAsync(DELAY_MS + 1);
      const [thread, history] = await resultsPromise;
      expect(thread).toMatchObject({ ok: true, data: 'read_thread' });
      expect(history).toMatchObject({ ok: true, data: 'author_history' });
      // If `execute` serialized the two calls (awaited one before starting
      // the other), only one would ever be in flight at once.
      expect(peakConcurrent).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
