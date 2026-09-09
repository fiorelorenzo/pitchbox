// shared/src/agents/sdk/runner.ts
//
// The `cloud` runner's real implementation (#415/#416): an ordinary
// `AgentRunner` that drives the model loop in this process, with the AI
// Gateway as its only remote. No separate compute service, no WebSocket relay
// - see docs/cloud-runner.md's "decided 2026-09-08" section for why that
// design was dropped and what replaced it.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { streamText, stepCountIs, type ToolSet, type PrepareStepFunction } from 'ai';
import {
  createGateway,
  type GatewayProvider,
  type GatewayLanguageModelEntry,
} from '@ai-sdk/gateway';
import type { AgentRunHandle, AgentRunOptions, AgentRunResult, AgentRunner } from '../base.js';
import type { RunnerConfig } from '../config.js';
import type { ParsedEvent } from '../../runlog/types.js';
import { createPitchboxToolSet, type PitchboxToolSet } from './tools.js';
import {
  normalizeSdkPart,
  normalizeStopReason,
  pricingFromCatalogueEntry,
  buildSdkUsage,
  addSdkUsage,
  type SdkStopReasonKind,
  type SdkUsage,
  type SdkLanguageModelUsage,
  type SdkModelPricing,
} from './event-normalizer.js';

export interface SdkRunnerOptions {
  config?: RunnerConfig;
  logDir?: string;
  /**
   * Step ceiling for `stopWhen(stepCountIs(n))`. #415's probe drove
   * `playbooks/hn-commenter.md` to completion in 7 steps (run_start, four
   * hn_search calls, drafts_create, run_finish) against a ceiling of 12;
   * kept as the default here for the same reason it worked there - generous
   * enough that a busier playbook (more candidates, a retried tool call)
   * still reaches its finish tool, tight enough that a model stuck calling
   * the same tool in a loop does not run unbounded. A playbook that
   * genuinely needs more is a per-scenario override, not a reason to raise
   * the shared default (docs/cloud-runner.md, decision #3).
   */
  stepCeiling?: number;
  /** Test-only: replace the AI SDK's `streamText` with a fake. */
  streamTextFn?: typeof streamText;
  /** Test-only: replace `createGateway` with a fake. */
  createGatewayFn?: typeof createGateway;
  /** Test-only: replace `createPitchboxToolSet` with a fake. */
  createToolSetFn?: typeof createPitchboxToolSet;
}

const DEFAULT_STEP_CEILING = 12;

// Gateway model catalogue (for per-token pricing) is fetched once per
// process and reused - it changes on the Gateway's own release cadence, not
// per run, and fetching it per run would add a network round trip to every
// dispatch for a number a five-minute-old cache answers just as well.
const MODEL_CATALOGUE_TTL_MS = 5 * 60 * 1000;
let modelCatalogueCache: { value: GatewayLanguageModelEntry[]; expiresAt: number } | null = null;

// Test-only escape hatch: the cache above is intentionally process-lifetime
// in production (see the comment on it), but that means every SdkRunner
// test in the same file/process shares one cache - a plain-catalogue test
// that runs first would otherwise poison a later test's custom pricing for
// up to five minutes. Not used by any production code path.
export function __resetModelCatalogueCacheForTests(): void {
  modelCatalogueCache = null;
}

async function loadModelCatalogue(gateway: GatewayProvider): Promise<GatewayLanguageModelEntry[]> {
  const now = Date.now();
  if (modelCatalogueCache && modelCatalogueCache.expiresAt > now) return modelCatalogueCache.value;
  try {
    const response = await gateway.getAvailableModels();
    modelCatalogueCache = { value: response.models, expiresAt: now + MODEL_CATALOGUE_TTL_MS };
    return response.models;
  } catch {
    // Pricing is best-effort: a catalogue hiccup should not fail the run,
    // only leave its cost unpriced (buildSdkUsage then returns costUsd: null).
    return [];
  }
}

function posInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export class SdkRunner implements AgentRunner {
  readonly slug = 'cloud';
  private readonly config: RunnerConfig;
  private readonly logDir: string;
  private readonly stepCeiling: number;
  private readonly streamTextFn: typeof streamText;
  private readonly createGatewayFn: typeof createGateway;
  private readonly createToolSetFn: typeof createPitchboxToolSet;

  constructor(opts: SdkRunnerOptions = {}) {
    this.config = opts.config ?? {};
    this.logDir = opts.logDir ?? join(process.cwd(), 'daemon', 'logs');
    this.stepCeiling = opts.stepCeiling ?? DEFAULT_STEP_CEILING;
    this.streamTextFn = opts.streamTextFn ?? streamText;
    this.createGatewayFn = opts.createGatewayFn ?? createGateway;
    this.createToolSetFn = opts.createToolSetFn ?? createPitchboxToolSet;
  }

  run(opts: AgentRunOptions): AgentRunHandle {
    const controller = new AbortController();
    // Which AbortSignal fired, decided by us and nobody else: an aborted
    // `streamText` does not throw, it ends the stream cleanly with
    // `finishReason: 'other'` (docs/cloud-runner.md #415, measured against
    // the real Gateway). Reading that finish reason as success would record
    // a cancelled or timed-out run as completed, so the outcome comes from
    // this flag, never from whether the loop below threw.
    let outcome: 'cancel' | 'timeout' | 'quota' | null = null;

    const cancelFn = () => {
      if (outcome) return; // already terminal - a second cancel is a no-op
      outcome = 'cancel';
      controller.abort();
    };

    // A separate closure, exactly like `cancelFn` above, rather than an
    // inline `outcome = 'quota'` where it's used (inside the loop below):
    // TypeScript's control-flow narrowing only sees same-scope assignments,
    // and `cancelFn`/the timeout callback already sit in their own closures
    // for that reason - an inline assignment in the loop narrowed `outcome`
    // down to `'quota' | null` for every later read in this function,
    // making the `stopReasonKind` ternary's `'cancel'`/`'timeout'`
    // comparisons look like dead code to the type checker.
    const markQuotaExceeded = () => {
      outcome = 'quota';
      controller.abort();
    };

    const result: Promise<AgentRunResult> = (async () => {
      mkdirSync(this.logDir, { recursive: true });
      const logPath = join(this.logDir, `run-${Date.now()}-sdk.log`);
      writeFileSync(logPath, `# sdk run started ${new Date().toISOString()}\n`, 'utf8');
      const log = (line: string) => appendFileSync(logPath, `${line}\n`, 'utf8');

      // Fail loudly and immediately when the deployment has no Gateway
      // credential, rather than let the first streamText call surface an
      // opaque provider auth error at the first token.
      const apiKey = process.env.AI_GATEWAY_API_KEY;
      if (!apiKey) {
        throw new Error(
          'AI_GATEWAY_API_KEY is not set: the SDK runner has no Gateway key to reach any model. ' +
            'Set it in this deployment\u2019s environment before dispatching a cloud-runner run.',
        );
      }

      // Model resolution is entirely #411's job (resolveFunctionModel /
      // resolveModelForRun in shared/src/ai/model-functions.ts) - the
      // dispatcher resolves it and writes it into this runner's
      // `RunnerConfig.model` before construction (see
      // `runnerTakesGatewayModel` / `web/src/lib/server/runner.ts`). This
      // runner never resolves or defaults one itself.
      const modelId = this.config.model?.trim();
      if (!modelId) {
        throw new Error(
          'SdkRunner has no resolved Gateway model id (config.model). The caller should have set ' +
            'this via resolveModelForRun before constructing the runner.',
        );
      }

      // A direct `prompt` wins over `playbookPath`, matching AcpRunner: one
      // of the two is required, since prompting with nothing burns a call
      // and returns nothing. Unlike ACP, the playbook becomes the *system*
      // prompt and the task line is the user turn (docs/cloud-runner.md
      // decision #3) rather than one concatenated blob.
      let system: string | undefined;
      let userText: string;
      if (opts.prompt != null) {
        userText = opts.prompt;
      } else if (opts.playbookPath) {
        system = await readFile(opts.playbookPath, 'utf8');
        // The one line ACP's `buildPrompt` prepends to the whole prompt,
        // relocated to the user turn now that the playbook itself is the
        // system prompt (docs/cloud-runner.md decision #3).
        userText = `You are running the Pitchbox playbook '${opts.slug}' for campaign ${opts.env.PITCHBOX_CAMPAIGN_ID ?? ''}.`;
      } else {
        throw new Error('SdkRunner.run needs either a prompt or a playbookPath');
      }

      const gateway = this.createGatewayFn({ apiKey });
      const model = gateway(modelId);

      // Resolved before the stream starts, not just at the end as before
      // #419: the mid-stream budget check below needs to price each step's
      // usage as it accumulates, and `loadModelCatalogue` is cached process-
      // wide anyway so moving it earlier costs nothing on a warm cache.
      const catalogueEntries = await loadModelCatalogue(gateway);
      const pricing: SdkModelPricing | undefined = pricingFromCatalogueEntry(
        catalogueEntries.find((m) => m.id === modelId),
      );

      // A direct tool set (#566, the in-page assistant's own plane) wins
      // over the campaign MCP server entirely - it has nothing to do with a
      // `runs` row and must never share the campaign server's connection or
      // its 26 mostly-writer tools. `attachMcp: false` (still used by a
      // suggestion that carries no tool set at all) keeps its old meaning:
      // nothing for it to write, and a tool loop is what a real-time path
      // cannot afford.
      let toolSet: PitchboxToolSet | undefined;
      let tools: ToolSet | undefined;
      if (opts.tools) {
        tools = opts.tools as ToolSet;
      } else if (opts.attachMcp !== false) {
        // Session binding read from the per-run env `dispatchRun` builds
        // (PITCHBOX_RUN_ID etc, web/src/lib/server/runner.ts) - there is no
        // child process to forward it to here, unlike the ACP backend, and
        // an explicit context wins over `createPitchboxMcpServer`'s own
        // `process.env` fallback (cli/src/mcp/server.ts), which matters
        // because this runner shares a process with every other run.
        toolSet = await this.createToolSetFn({
          runId: posInt(opts.env.PITCHBOX_RUN_ID),
          campaignId: posInt(opts.env.PITCHBOX_CAMPAIGN_ID),
          projectId: posInt(opts.env.PITCHBOX_PROJECT_ID) ?? posInt(opts.env.PROJECT_ID),
        });
        tools = toolSet?.tools as ToolSet | undefined;
      }

      // The step/time/token budget (#566, docs/design/in-page-agent.md
      // section 2) is a nudge, not a hard stop: once any threshold trips,
      // the next step is offered no tools at all, so the model must answer
      // with whatever it already gathered instead of calling another one.
      // `stepNumber` is zero-based and `steps` holds only the steps already
      // completed (ai's own `prepareStep` contract), so this fires on the
      // step *at* the index budget - "five tool steps plus the writing
      // turn" reads as steps 0-4 free, step 5 forced text-only.
      const loopBudget = opts.toolLoopBudget;
      const loopStartedAt = Date.now();
      const prepareStep: PrepareStepFunction<ToolSet> | undefined = loopBudget
        ? ({ stepNumber, steps, instructions }) => {
            const elapsedMs = Date.now() - loopStartedAt;
            const tokensSoFar = steps.reduce(
              (sum, step) => sum + (step.usage.inputTokens ?? 0),
              0,
            );
            const overBudget =
              stepNumber >= loopBudget.maxSteps - 1 ||
              elapsedMs >= loopBudget.softBudgetMs ||
              tokensSoFar >= loopBudget.tokenBudget;
            if (!overBudget) return undefined;
            // `instructions` only carries a plain string in this runner's
            // own usage (a suggestion never sets `system`) - a structured
            // `SystemModelMessage`/array is left behind rather than merged,
            // since nothing here produces one today.
            const base = typeof instructions === 'string' ? instructions : undefined;
            const nudge =
              'You are at your step, time, or token budget for this answer. Do not call ' +
              'any more tools. Write your best answer now using only what you have already ' +
              'gathered.';
            return { toolChoice: 'none' as const, instructions: base ? `${base}\n\n${nudge}` : nudge };
          }
        : undefined;

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        timeoutTimer = setTimeout(() => {
          if (!outcome) {
            outcome = 'timeout';
            controller.abort();
          }
        }, opts.timeoutMs);

        // Buffers for streamed assistant/thinking text, coalesced into one
        // ParsedEvent per message instead of one per delta - otherwise every
        // generated token/group would produce its own runlog row, the same
        // problem AcpRunner's `pendingAssistantText` buffer avoids for ACP's
        // `agent_message_chunk`. Flushed through `normalizeSdkPart` with a
        // synthetic single-part `text-delta`/`reasoning-delta`, the same
        // shape it already builds for the real per-chunk case.
        let seq = 0;
        let pendingAssistantText = '';
        let pendingThinkingText = '';

        const flushPendingText = () => {
          const events: ParsedEvent[] = [];
          if (pendingAssistantText) {
            events.push(
              ...normalizeSdkPart({ type: 'text-delta', text: pendingAssistantText }, '', seq),
            );
            seq += 1;
            pendingAssistantText = '';
          }
          if (pendingThinkingText) {
            events.push(
              ...normalizeSdkPart({ type: 'reasoning-delta', text: pendingThinkingText }, '', seq),
            );
            seq += 1;
            pendingThinkingText = '';
          }
          if (events.length > 0) void opts.onParsedEvents?.(events);
        };

        let sawErrorPart = false;
        let stepCount = 0;
        // Accumulated across `finish-step` parts as the loop runs, not read
        // once at the end: a mid-loop provider error closes the stream with
        // an `error` part and no top-level `finish` part at all (confirmed
        // against `ai`'s own streamText source), so `result.totalUsage`
        // alone would report zero for a run that still spent real tokens.
        let stepUsage: SdkLanguageModelUsage | undefined;
        let finishUsage: SdkLanguageModelUsage | undefined;
        let finishReason: string | undefined;

        try {
          const streamResult = this.streamTextFn({
            model,
            system,
            messages: [{ role: 'user', content: userText }],
            tools,
            stopWhen: stepCountIs(this.stepCeiling),
            prepareStep,
            abortSignal: controller.signal,
          });

          try {
            for await (const part of streamResult.fullStream) {
              const raw = JSON.stringify(part);
              log(`[part] ${raw}`);
              opts.onRawLine?.(raw);

              if (part.type === 'text-delta') {
                const text = part.text ?? '';
                pendingAssistantText += text;
                if (text) opts.onTextChunk?.(text);
                continue;
              }
              if (part.type === 'reasoning-delta') {
                pendingThinkingText += part.text ?? '';
                continue;
              }
              flushPendingText();

              if (part.type === 'finish-step') {
                stepCount += 1;
                stepUsage = addSdkUsage(stepUsage, part.usage);
                // Stop the run the moment its own accumulated cost would
                // push the org over its remaining monthly Gateway budget
                // (#419), rather than only discovering it once the run
                // finishes - `opts.budgetRemainingUsd` is a snapshot taken
                // by the caller at dispatch time (shared/src/org-quota.ts).
                // Skipped when pricing is unknown (`costUsd` null): an
                // un-priced model can't be judged against a budget, so it
                // runs unmetered rather than aborting on a guess.
                if (!outcome && opts.budgetRemainingUsd != null) {
                  const runningCostUsd = buildSdkUsage(stepUsage, { pricing }).costUsd;
                  if (runningCostUsd != null && runningCostUsd >= opts.budgetRemainingUsd) {
                    markQuotaExceeded();
                  }
                }
              } else if (part.type === 'finish') {
                finishUsage = part.totalUsage;
                finishReason = part.finishReason;
              } else if (part.type === 'error') {
                sawErrorPart = true;
              }

              const produced = normalizeSdkPart(part, raw, seq);
              seq += Math.max(produced.length, 1);
              if (produced.length > 0) void opts.onParsedEvents?.(produced);
            }
          } catch (err) {
            // A genuine mid-run failure (network error, provider fetch
            // throw) that is NOT our own abort - a self-requested abort is
            // handled entirely through `outcome`, set above, and never
            // reaches here as a reason to reclassify the run.
            if (!outcome) {
              sawErrorPart = true;
              log(
                `[loop-error] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
              );
            }
          }
        } finally {
          flushPendingText();
        }

        const stopReasonKind: SdkStopReasonKind =
          outcome === 'cancel'
            ? 'cancelled'
            : outcome === 'timeout'
              ? 'timeout'
              : outcome === 'quota'
                ? 'quota_exceeded'
                : sawErrorPart || finishReason === 'error'
                  ? 'error'
                  : finishReason === 'content-filter'
                    ? 'refusal'
                    : finishReason === 'tool-calls' && stepCount >= this.stepCeiling
                      ? 'max_turn_requests'
                      : 'end_turn';

        // Only a genuine runner-level failure is a non-zero exit: whether
        // the agent actually finished its job (called the playbook's finish
        // tool) is `playbookContractError`'s job downstream
        // (web/src/lib/server/runner.ts), exactly as it already is for
        // AcpRunner, whose exit code reflects the CLI process, not the
        // model's own verdict on itself.
        const exitCode =
          stopReasonKind === 'cancelled' ||
          stopReasonKind === 'timeout' ||
          stopReasonKind === 'error' ||
          stopReasonKind === 'quota_exceeded'
            ? 1
            : 0;

        // `pricing` was already resolved before the stream started (above),
        // so the final usage is priced with the exact same table the
        // mid-stream check used - no second catalogue fetch here.
        const usage = finishUsage ?? stepUsage ?? {};
        const usageResult = buildSdkUsage(usage, { pricing });
        const tokensUsed = usageResult.inputTokens + usageResult.outputTokens;

        const sdkUsageForEvent: SdkUsage = {
          inputTokens: usageResult.inputTokens,
          outputTokens: usageResult.outputTokens,
          cacheReadTokens: usageResult.cacheReadTokens,
          cacheCreationTokens: usageResult.cacheCreationTokens,
          totalCostUsd: usageResult.costUsd ?? undefined,
        };
        const tail = normalizeStopReason(stopReasonKind, sdkUsageForEvent, '', seq);
        seq += tail.length;
        if (tail.length > 0) void opts.onParsedEvents?.(tail);

        log(
          `# sdk run finished ${new Date().toISOString()} stopReason=${stopReasonKind} exitCode=${exitCode}`,
        );

        return { exitCode, logPath, tokensUsed, usage: usageResult };
      } finally {
        clearTimeout(timeoutTimer);
        await toolSet?.close().catch(() => {});
      }
    })();

    return { result, cancel: () => cancelFn() };
  }
}
