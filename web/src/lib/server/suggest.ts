import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from './db.js';
import { createAgentRunner } from '@pitchbox/shared/agents/registry';
import type { AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { loadRunnerConfig, type RunnerConfig } from '@pitchbox/shared/agents/config';
import {
  buildSuggestionPrompt,
  type ObservedPost,
  type ProjectVoice,
  type SuggestionKind,
} from '@pitchbox/shared/assist/suggest-prompt';

/**
 * Runs one suggestion: a single-turn agent invocation with no playbook, no MCP
 * server and no `runs` row, streaming its text out as it is produced.
 *
 * It goes through the same `AgentRunner` a campaign run goes through, on
 * purpose. The alternative was a second spawn path next to the first, which
 * would drift: this way the cloud edition dispatches a suggestion to the
 * managed runner exactly as it dispatches a run, and a self-host with a local
 * agent CLI spawns it locally, with no per-edition branch here.
 *
 * No provider API key is introduced. Pitchbox authenticates through the
 * human's own subscription, and requiring a key would break self-hosting to
 * save a few seconds of first-token latency. Expect five to ten seconds,
 * dominated by process spawn; #318 is the recorded follow-up if that proves
 * too slow in real use.
 */
export interface SuggestionResult {
  text: string;
  ms: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
}

export interface SuggestionHandle {
  result: Promise<SuggestionResult>;
  cancel: () => void;
}

/** A suggestion the human is waiting on has a much shorter patience than a
 * campaign run. Past this the answer is not worth having. */
const SUGGESTION_TIMEOUT_MS = 90_000;

/**
 * The model a suggestion asks for when an operator has not pinned one for
 * this runner. A campaign run is unattended and can afford the most capable
 * model; a suggestion has a human staring at an empty panel, and the wait is
 * dominated by how long the model deliberates before its first text token,
 * not by the spawn.
 *
 * Measured on an idle devbox, same prompt (3043 chars), claude-code, n=3 each
 * (see #360 for the full table):
 *
 *   unpinned (session default)  median 16.8s to first token, 19.8s total
 *   sonnet                      median 10.4s to first token, 12.9s total
 *
 * Spawn plus `session/new` is 2.2s of either, which is why this is the lever
 * and a pool of warm processes is not (#318).
 */
export const ASSIST_DEFAULT_MODEL = 'sonnet';

/**
 * An explicit runner config wins: an operator who pinned a model for this
 * runner meant it, including for suggestions. Everything else, including an
 * empty string from a cleared form field, falls back to the fast default.
 */
export function resolveAssistRunnerConfig(config: RunnerConfig): RunnerConfig {
  const pinned = config.model?.trim();
  return pinned ? config : { ...config, model: ASSIST_DEFAULT_MODEL };
}

export function runSuggestion(args: {
  kind: SuggestionKind;
  post: ObservedPost;
  project: ProjectVoice;
  hint?: string;
  projectId: number;
  orgId?: number;
  runnerSlug: string;
  onFirstChunk?: () => void;
  onChunk?: (text: string) => void;
}): SuggestionHandle {
  const prompt = buildSuggestionPrompt({
    kind: args.kind,
    post: args.post,
    project: args.project,
    hint: args.hint,
  });

  // `cancel()` can arrive before the runner exists: resolving its config and
  // making a temp directory are both awaits, and a human who closes the panel
  // immediately lands in that window. A cancel that only forwards to a handle
  // would do nothing there and the agent would then start and run to
  // completion for nobody, which is the exact failure this path exists to
  // prevent. So the flag is authoritative and the handle is best-effort.
  let cancelHandle: (() => void) | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    cancelHandle?.();
  };
  const started = Date.now();

  class Cancelled extends Error {
    constructor() {
      super('cancelled');
    }
  }

  const result: Promise<SuggestionResult> = (async () => {
    const db = getDb();
    if (cancelled) throw new Cancelled();
    const config = await loadRunnerConfig(db, args.runnerSlug as AgentRunnerSlug);
    if (cancelled) throw new Cancelled();
    const runner = createAgentRunner(args.runnerSlug, resolveAssistRunnerConfig(config));

    // The agent still gets a working directory, and it must not be the repo:
    // this session has no tools attached, but a cwd it could read is a cwd it
    // should not have. An empty temp directory is the smallest thing that
    // satisfies the ACP `session/new` contract.
    const cwd = await mkdtemp(join(tmpdir(), 'pitchbox-suggest-'));
    // Last gate before the spawn, and the one that matters most: past here a
    // process exists and only the handle can stop it.
    if (cancelled) {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      throw new Cancelled();
    }

    let text = '';
    let sawChunk = false;

    try {
      const handle = runner.run({
        prompt,
        attachMcp: false,
        slug: `assist-${args.kind}`,
        env: {},
        cwd,
        timeoutMs: SUGGESTION_TIMEOUT_MS,
        orgId: args.orgId,
        onTextChunk: (chunk) => {
          if (!sawChunk) {
            sawChunk = true;
            args.onFirstChunk?.();
          }
          text += chunk;
          args.onChunk?.(chunk);
        },
      });
      cancelHandle = handle.cancel;
      // A cancel that landed between the last gate and this assignment still
      // has to reach the process it just missed.
      if (cancelled) handle.cancel();
      const run = await handle.result;

      if (cancelled) throw new Cancelled();
      if (!text.trim()) {
        // A zero-text turn is a failure the panel has to be told about: an
        // empty suggestion area with a "done" event reads as a broken panel.
        throw new Error(
          run.exitCode === 0
            ? 'the agent produced no text'
            : `the agent exited ${run.exitCode} without producing text`,
        );
      }
      return {
        text: text.trim(),
        ms: Date.now() - started,
        usage: run.usage
          ? {
              inputTokens: run.usage.inputTokens,
              outputTokens: run.usage.outputTokens,
              costUsd: run.usage.costUsd,
            }
          : undefined,
      };
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return { result, cancel };
}
