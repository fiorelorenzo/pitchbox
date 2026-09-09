import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from './db.js';
import { createAgentRunner } from '@pitchbox/shared/agents/registry';
import type { AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { loadRunnerConfig, type RunnerConfig } from '@pitchbox/shared/agents/config';
import { isRunnerAllowed } from '@pitchbox/shared/edition';
import {
  resolveFunctionModel,
  runnerTakesGatewayModel,
  gateModelForPlan,
} from '@pitchbox/shared/ai/model-functions';
import { resolveEntitlements } from '@pitchbox/shared/plans';
import {
  buildSuggestionPrompt,
  type CurrentProject,
  type ObservedPost,
  type RetuneDirection,
  type SuggestionKind,
} from '@pitchbox/shared/assist/suggest-prompt';
import { EnvelopeSplitter, type EnvelopeChunk } from '@pitchbox/shared/assist/envelope';
import type {
  CodeRepo,
  OperatorPersona,
  ProjectBrief,
  VoiceProfileSummary,
} from '@pitchbox/shared/assist/context';
import type { ExampleCandidate } from '@pitchbox/shared/assist/example-selection';
import type { AssistTone } from '@pitchbox/shared/assist/tone';
import type { AgentRunner } from '@pitchbox/shared/agents';
import {
  buildRewriteInstruction,
  enforceHouseStyle,
  type StyleFinding,
} from '@pitchbox/shared/style-check';
import { ASSIST_TOOLS } from '@pitchbox/shared/assist/tools';
import { buildAssistToolSet } from '@pitchbox/shared/assist/loop';
import {
  ASSIST_HARD_TIMEOUT_MS,
  ASSIST_MAX_STEPS,
  ASSIST_SOFT_BUDGET_MS,
  ASSIST_TOKEN_BUDGET,
  ASSIST_COST_CEILING_USD,
} from '@pitchbox/shared/assist/budget';
import { resolveDeviceOrgId } from './extension-auth.js';

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
  /** Why the model wrote what it wrote. Shown, never insertable. */
  reasoning: string;
  /** The text the human may insert, or null when the model gave nothing to
   * insert - no marker, or an explicit skip (#382, envelope.ts). */
  draft: string | null;
  /** House style findings (#572) the mechanical repair pass and one
   * targeted-rewrite round trip could not resolve on `draft`. Empty or
   * absent means the draft is clean; a non-empty list travels with the
   * draft rather than being silently accepted - the caller shows it next
   * to the draft instead of trusting it blind. */
  styleFindings?: StyleFinding[];
  /** True when the model explicitly declined to write a draft. */
  skipped: boolean;
  ms: number;
  /** The model this suggestion actually asked for - resolveAssistRunnerConfig's
   * result, so an unpinned runner reports ASSIST_DEFAULT_MODEL rather than
   * undefined. Carried through so a caller that ledgers usage (#522's
   * assist_usage row) knows which model to price it against, even on a
   * suggestion whose cost couldn't be computed at all. */
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    // A suggestion's prompt is served from the provider's cache (issue #313
    // comment): `inputTokens` alone reads as ~2 tokens for an ~800-token
    // prompt because the cached remainder arrives as these two counts
    // instead. Carried through so a caller that writes them down (the
    // accept path's `runs` row) doesn't read as broken accounting.
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number | null;
  };
}

export interface SuggestionHandle {
  result: Promise<SuggestionResult>;
  cancel: () => void;
}

/** A suggestion the human is waiting on has a much shorter patience than a
 * campaign run - `ASSIST_HARD_TIMEOUT_MS` (`shared/src/assist/budget.ts`) is
 * the ceiling, not the target. */

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
 *
 * `functionModel` is the per-function configuration (#411), and it only exists
 * for a runner that speaks Gateway model ids. An ACP backend keeps
 * `ASSIST_DEFAULT_MODEL` instead: `sonnet` is that CLI's own vocabulary, and
 * `google/gemini-3.1-flash-lite` would fail the call on a local install that
 * never asked for any of this.
 */
export function resolveAssistRunnerConfig(
  config: RunnerConfig,
  functionModel?: string,
): RunnerConfig {
  const pinned = config.model?.trim();
  if (pinned) return config;
  return { ...config, model: functionModel?.trim() || ASSIST_DEFAULT_MODEL };
}

/**
 * The single targeted-rewrite round trip #572 asks for: one more turn on the
 * same runner that wrote the draft, naming the remaining structural
 * findings once, no streaming and no MCP tools attached - the same shape as
 * the suggestion turn itself, minus the parts a rewrite does not need.
 *
 * Returns the model's raw reply, unparsed, or `null` on a spawn failure or a
 * cancel that landed mid-flight. `enforceHouseStyle` is what extracts and
 * validates the reply (`extractRewrite`), exactly as suspiciously as the
 * suggestion turn's own envelope is treated: a reply with no marker is a
 * failed rewrite, never a draft.
 */
async function runStyleRewrite(
  runner: AgentRunner,
  text: string,
  findings: StyleFinding[],
  orgId: number | undefined,
  isCancelled: () => boolean,
  setCancelHandle: (cancel: () => void) => void,
): Promise<string | null> {
  const cwd = await mkdtemp(join(tmpdir(), 'pitchbox-style-rewrite-'));
  if (isCancelled()) {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  let rawText = '';
  try {
    const handle = runner.run({
      prompt: buildRewriteInstruction(text, findings),
      attachMcp: false,
      slug: 'assist-style-rewrite',
      env: {},
      cwd,
      timeoutMs: ASSIST_HARD_TIMEOUT_MS,
      orgId,
      onTextChunk: (chunk) => {
        rawText += chunk;
      },
    });
    setCancelHandle(handle.cancel);
    if (isCancelled()) handle.cancel();
    await handle.result;
    if (isCancelled()) return null;
    return rawText.trim() ? rawText : null;
  } catch {
    return null;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export function runSuggestion(args: {
  kind: SuggestionKind;
  post: ObservedPost;
  currentProject: CurrentProject;
  persona: OperatorPersona | null;
  voiceProfile: VoiceProfileSummary | null;
  projects: ProjectBrief[];
  repos: CodeRepo[];
  examples?: ExampleCandidate[];
  hint?: string;
  /**
   * A retune direction (#409): the panel's own regenerate-in-a-direction
   * control. Read straight from the request, unlike `tone`/`toneNotes` above:
   * it names no setting, so there is nothing server-side to override it with.
   */
  retune?: RetuneDirection;
  /**
   * The org's tone setting (#405). The caller reads it from
   * `loadLinkedInAssistSettings`, never from the request body: a tone in the
   * suggest payload is ignored, the same way `enabled` and `killSwitch` are
   * enforced here rather than trusted from the extension.
   */
  tone?: AssistTone;
  toneNotes?: string;
  projectId: number;
  orgId?: number;
  runnerSlug: string;
  /** One callback per model chunk, already split into its reasoning/draft
   * halves (#382). The caller decides what to do with each half - the SSE
   * route turns non-empty pieces into `chunk` events with a `section`. */
  onChunk?: (chunk: EnvelopeChunk) => void;
}): SuggestionHandle {
  const prompt = buildSuggestionPrompt({
    kind: args.kind,
    post: args.post,
    currentProject: args.currentProject,
    persona: args.persona,
    voiceProfile: args.voiceProfile,
    projects: args.projects,
    repos: args.repos,
    examples: args.examples,
    hint: args.hint,
    retune: args.retune,
    tone: args.tone,
    toneNotes: args.toneNotes,
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
    // Same edition boundary as a campaign run's dispatch pre-flight
    // (runner.ts): a suggestion reads `project.defaultAgentRunner` straight
    // off the project row, so a project whose snapshot predates the guard on
    // the write routes (or was written before this deployment ever ran the
    // cloud edition) would otherwise reach a local agent spawn here with no
    // check at all (#410).
    if (!isRunnerAllowed(args.runnerSlug)) {
      throw new Error(
        `Agent runner "${args.runnerSlug}" is not available in this deployment's edition: ` +
          `only the managed Pitchbox Cloud runner can dispatch here. Change the project's ` +
          `default runner in Settings to continue.`,
      );
    }
    const config = await loadRunnerConfig(db, args.runnerSlug as AgentRunnerSlug);
    if (cancelled) throw new Cancelled();
    // Which model answers in the panel is an instance-level setting a system
    // admin owns (#411), read here rather than baked in. Undefined for an ACP
    // backend, which keeps the fast alias it has always used.
    const functionModel = runnerTakesGatewayModel(args.runnerSlug)
      ? await resolveFunctionModel(db, 'assist_suggest')
      : undefined;
    if (cancelled) throw new Cancelled();
    let resolvedConfig = resolveAssistRunnerConfig(config, functionModel);
    // The premium-model gate (#547), next to resolveAssistRunnerConfig
    // rather than inside it: an org whose plan does not allow premium
    // models answers in the panel on the function's coded fast default
    // regardless of what an operator pinned here or in `model_functions`.
    if (runnerTakesGatewayModel(args.runnerSlug) && resolvedConfig.model && args.orgId != null) {
      const entitlements = await resolveEntitlements(db, args.orgId);
      const gated = await gateModelForPlan(
        'assist_suggest',
        resolvedConfig.model,
        entitlements.premiumModels,
      );
      if (gated !== resolvedConfig.model) resolvedConfig = { ...resolvedConfig, model: gated };
    }
    if (cancelled) throw new Cancelled();
    const runner = createAgentRunner(args.runnerSlug, resolvedConfig);

    // The agent still gets a working directory, and it must not be the repo:
    // even with the assist tool set attached below, nothing here reads or
    // writes the filesystem or a shell - the tools are the only capability
    // added (docs/design/in-page-agent.md, section 1). An empty temp
    // directory is the smallest thing that satisfies the ACP `session/new`
    // contract.
    const cwd = await mkdtemp(join(tmpdir(), 'pitchbox-suggest-'));
    // Last gate before the spawn, and the one that matters most: past here a
    // process exists and only the handle can stop it.
    if (cancelled) {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      throw new Cancelled();
    }

    // #566: the in-page assistant's own tool surface (`shared/src/assist/
    // tools.ts`, #567), wired in for the SDK runner via `opts.tools` -
    // `buildAssistToolSet` wraps every handler with the cancellation and
    // per-tool timeout enforcement (`shared/src/assist/loop.ts`). `AcpRunner`
    // ignores `opts.tools`/`opts.toolLoopBudget` entirely (its own assist MCP
    // entry point, `cli/bin/pitchbox-assist-mcp`, is a separate wiring), so
    // an ACP-backed suggestion keeps today's single, tool-less turn.
    //
    // The org id comes from the device's auth, falling back to the seeded
    // `default` organization exactly as the LinkedIn assist gate already
    // does (`resolveDeviceOrgId`) - a self-host with auth off still gets the
    // loop rather than losing it because there is no device-bound org to
    // scope tools to. Only a genuinely unseeded database (`toolOrgId` still
    // null) falls back to no tools at all, the same shape this suggestion
    // had before this issue.
    const toolOrgId = await resolveDeviceOrgId(db, args.orgId ?? null);
    const toolSet =
      toolOrgId != null
        ? buildAssistToolSet(ASSIST_TOOLS, {
            db,
            orgId: toolOrgId,
            boundProjectId: args.projectId,
            observedTarget: args.post,
            operator: args.persona,
          })
        : undefined;

    // `rawText` is the whole response, unsplit - used only to tell an actual
    // zero-text turn (a real failure) apart from a well-formed response whose
    // envelope happens to carry no draft (#382: that is a success, not an
    // error). The splitter itself is what decides what the panel gets.
    let rawText = '';
    const splitter = new EnvelopeSplitter();

    try {
      const handle = runner.run({
        prompt,
        attachMcp: false,
        slug: `assist-${args.kind}`,
        env: {},
        cwd,
        timeoutMs: ASSIST_HARD_TIMEOUT_MS,
        orgId: args.orgId,
        tools: toolSet,
        // Only meaningful alongside `tools` - `SdkRunner` gates its own
        // `prepareStep` enforcement on this being set, so the two travel
        // together or not at all (docs/design/in-page-agent.md, section 2).
        toolLoopBudget: toolSet
          ? {
              maxSteps: ASSIST_MAX_STEPS,
              softBudgetMs: ASSIST_SOFT_BUDGET_MS,
              tokenBudget: ASSIST_TOKEN_BUDGET,
              costCeilingUsd: ASSIST_COST_CEILING_USD,
            }
          : undefined,
        onTextChunk: (chunk) => {
          rawText += chunk;
          // `args.onChunk?.(splitter.push(chunk))` looks equivalent but is
          // not: optional-call short-circuiting skips evaluating its
          // arguments too, so a caller with no `onChunk` (every direct
          // caller of `runSuggestion` that isn't the SSE route - #572's own
          // integration test is one) would never feed the splitter at all,
          // and `envelope.draft` would always come back null regardless of
          // what the model actually said. Pushing unconditionally keeps
          // `onChunk`-less callers correct without changing anything for
          // the streaming route, which always passes one.
          const pushed = splitter.push(chunk);
          args.onChunk?.(pushed);
        },
      });
      cancelHandle = handle.cancel;
      // A cancel that landed between the last gate and this assignment still
      // has to reach the process it just missed.
      if (cancelled) handle.cancel();
      const run = await handle.result;

      if (cancelled) throw new Cancelled();
      if (!rawText.trim()) {
        // A zero-text turn is a failure the panel has to be told about: an
        // empty suggestion area with a "done" event reads as a broken panel.
        throw new Error(
          run.exitCode === 0
            ? 'the agent produced no text'
            : `the agent exited ${run.exitCode} without producing text`,
        );
      }
      const envelope = splitter.finish();

      // #572: everything the human may insert is held to the same
      // deterministic house-style check a campaign draft is. Only `draft`
      // goes through it - `reasoning` is operator-facing and never posted,
      // the same reason the assist plane never lets it near the composer
      // (#382, envelope.ts). A cancel is checked before the round trip
      // starts; once `runStyleRewrite` is under way it watches the same
      // flag itself.
      let draft = envelope.draft;
      let styleFindings: StyleFinding[] = [];
      if (draft != null && !cancelled) {
        const enforcement = await enforceHouseStyle(draft, (rewriteText, findings) =>
          runStyleRewrite(
            runner,
            rewriteText,
            findings,
            args.orgId,
            () => cancelled,
            (handle) => {
              cancelHandle = handle;
            },
          ),
        );
        draft = enforcement.text;
        styleFindings = enforcement.findings;
      }

      return {
        reasoning: envelope.reasoning,
        draft,
        styleFindings: styleFindings.length > 0 ? styleFindings : undefined,
        skipped: envelope.skipped,
        ms: Date.now() - started,
        model: resolvedConfig.model,
        usage: run.usage
          ? {
              inputTokens: run.usage.inputTokens,
              outputTokens: run.usage.outputTokens,
              cacheReadTokens: run.usage.cacheReadTokens,
              cacheCreationTokens: run.usage.cacheCreationTokens,
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
