// shared/src/assist/loop.ts (#566)
//
// Bridges #567's tool declarations (`shared/src/assist/tools.ts`) into a
// native Vercel AI SDK tool set for `SdkRunner`'s loop
// (docs/design/in-page-agent.md, "The SDK path wraps those handlers as
// native tools"). One enforcement point, applied uniformly to every tool
// regardless of what its own handler does or doesn't check:
//
//   - a cancelled suggestion never starts a new tool handler at all - `ai`
//     hands every `execute` call the same `abortSignal` it passed
//     `streamText` (`SdkRunner`'s own `controller.signal`, tripped by
//     `handle.cancel()`), so this checks that signal directly rather than
//     asking the caller to thread a second one;
//   - a tool that is already running gets its per-tool ceiling
//     (`ASSIST_TOOL_TIMEOUT_MS`, or `ASSIST_VISION_TIMEOUT_MS` for
//     `look_at_image`) merged with that same cancellation signal, so
//     `look_at_image`'s real Gateway call actually stops rather than
//     running to completion for nobody - "a suggestion nobody is waiting
//     for that keeps calling the Gateway is a bug that only shows up on
//     the bill" (design doc, section 2).
//
// Takes the tool list as a parameter rather than importing `ASSIST_TOOLS`
// itself, so this module (and its tests) never depend on the seven real
// handlers existing - `web/src/lib/server/suggest.ts` is the one caller that
// wires the real `ASSIST_TOOLS` in.

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AssistTool, AssistToolAnswer, AssistToolContext } from './tools.js';
import { ASSIST_TOOL_TIMEOUT_MS, ASSIST_VISION_TIMEOUT_MS } from './budget.js';

/** `look_at_image` is a real model call whose cost and latency dwarf the
 * other six (design doc, section 2) - it alone gets the longer ceiling. */
function toolTimeoutMs(name: string): number {
  return name === 'look_at_image' ? ASSIST_VISION_TIMEOUT_MS : ASSIST_TOOL_TIMEOUT_MS;
}

/**
 * Races `handler` against `ms` and, separately, against `outerSignal`
 * firing - whichever comes first. Neither the five DB tools nor a genuine
 * network hang stop producing a value on their own, so this is a "stop
 * waiting", not a true cancel, for anything but `look_at_image` (the one
 * handler that threads `signal` into a real `fetch`); the loop must not
 * block on a broken tool regardless of whether the tool itself cooperates.
 */
function runWithBudget<T>(
  handler: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outerSignal: AbortSignal | undefined,
  onAbort: (reason: 'timeout' | 'cancelled') => T,
): Promise<T> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), ms);
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, timeoutController.signal])
    : timeoutController.signal;
  // shared's tsconfig targets a lib without `Promise.withResolvers`
  // (cli/src/lib/password.ts hit the same wall) - the executor form is the
  // one that typechecks here.
  const abortRace = new Promise<T>((resolve) => {
    const settle = () =>
      resolve(onAbort(timeoutController.signal.aborted ? 'timeout' : 'cancelled'));
    if (signal.aborted) settle();
    else signal.addEventListener('abort', settle, { once: true });
  });
  return Promise.race([handler(signal), abortRace]).finally(() => clearTimeout(timer));
}

/**
 * Wraps every `AssistTool` handler as a native `ai` tool: same JSON schema,
 * same server-resolved `ctx` (the model supplies no authority, per the
 * design doc's "What the agent may know and do"), the timeout/cancellation
 * enforcement above applied once instead of per-handler. Independent tools
 * requested in the same model turn execute concurrently because `ai`'s own
 * `streamText` runs every tool call in a step through `Promise.all` - this
 * function only has to avoid accidentally serializing them itself, which it
 * doesn't: each entry's `execute` is an independent async function with no
 * shared lock between tools.
 */
export function buildAssistToolSet(
  // mirrors tools.ts's own `ASSIST_TOOLS: Array<AssistTool<any, any>>`, heterogeneous by
  // construction - each tool's own TArgs/TResult differs, so the array itself has to erase them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<AssistTool<any, any>>,
  ctx: AssistToolContext,
): ToolSet {
  const toolSet: ToolSet = {};
  for (const assistTool of tools) {
    toolSet[assistTool.name] = tool({
      description: assistTool.description,
      inputSchema: z.object(assistTool.schema),
      execute: async (
        args: Record<string, unknown>,
        options: { abortSignal?: AbortSignal },
      ): Promise<AssistToolAnswer<unknown>> => {
        if (options.abortSignal?.aborted) {
          return { ok: false, reason: `${assistTool.name}: suggestion was cancelled` };
        }
        return runWithBudget(
          (signal) => assistTool.handler(ctx, args, signal),
          toolTimeoutMs(assistTool.name),
          options.abortSignal,
          (reason) => ({
            ok: false,
            reason:
              reason === 'timeout'
                ? `${assistTool.name} did not answer within its time budget`
                : `${assistTool.name}: suggestion was cancelled`,
          }),
        );
      },
    });
  }
  return toolSet;
}
