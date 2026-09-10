import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createGateway } from '@ai-sdk/gateway';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { getDb, schema } from '@pitchbox/shared/db';
import { __resetModelCatalogueCacheForTests } from '@pitchbox/shared/agents/sdk/runner';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import type { ObservedPost } from '@pitchbox/shared/assist/suggest-prompt';
import {
  ASSIST_MAX_STEPS,
  ASSIST_SOFT_BUDGET_MS,
  ASSIST_TOKEN_BUDGET,
  ASSIST_COST_CEILING_USD,
} from '@pitchbox/shared/assist/budget';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #566: the loop itself - what `extension-suggest-loop-wiring.test.ts`
 * leaves out because it fakes the runner entirely. Here the runner is real
 * (`SdkRunner`, unmocked) driven by the real `ai` `streamText` engine
 * (unmocked too) against a scripted `MockLanguageModelV4` - only the model
 * at the very bottom is fake, so a step with several tool calls is actually
 * dispatched by the AI SDK's own tool-execution machinery, not reimplemented
 * by this file. What this defends: a suggestion needing several things takes
 * several steps and issues independent tool calls together rather than one
 * per turn; a suggestion needing nothing extra still takes one turn;
 * cancelling mid-step stops the loop from spending anything further; each of
 * the four soft budgets (steps, wall-clock, tokens, cost) forces a usable draft
 * rather than an error; and the usage the accept path ledgers is the sum
 * across every step, not just the last one.
 */

let logDirs: string[] = [];
let currentGatewayFn: typeof createGateway | null = null;

// Dynamic import inside the factory rather than a top-level one: `SdkRunner`
// is the real class under test here and is never mocked, but referencing a
// regular top-level import from inside `vi.mock`'s factory trips vitest's
// hoisting guard (the factory is moved above every import in the transformed
// module). The factory body itself only runs later, once `createAgentRunner`
// is actually called at test time, well after the module has finished
// loading either way.
vi.mock('@pitchbox/shared/agents/registry', async () => {
  const { SdkRunner } = await import('@pitchbox/shared/agents/sdk/runner');
  return {
    createAgentRunner: (_slug: string, config: RunnerConfig) => {
      if (!currentGatewayFn) {
        throw new Error('test must call useModel(...) before invoking runSuggestion');
      }
      const logDir = mkdtempSync(join(tmpdir(), 'sdk-loop-test-'));
      logDirs.push(logDir);
      return new SdkRunner({ config, logDir, createGatewayFn: currentGatewayFn });
    },
  };
});

// Dynamic, matching every other route/suggest test in this repo (see
// extension-suggest-loop-wiring.test.ts) - a static import here would race
// the `vi.mock` registration above and pick up the real registry instead of
// the fake one.
const { runSuggestion } = await import('../src/lib/server/suggest.js');

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

type FakeUsage = { inputTokens: number; outputTokens: number };

function usage(u: FakeUsage): LanguageModelV4Usage {
  return {
    inputTokens: { total: u.inputTokens, noCache: u.inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: u.outputTokens, text: u.outputTokens, reasoning: 0 },
  };
}

/** One model turn that calls every named tool, all in the same step - the
 * shape a step with several independent tool calls actually takes on the
 * wire. `ai`'s own engine (not this file) is what then runs them
 * concurrently via `Promise.all`; `shared/tests/assist/loop.test.ts`
 * already proves `buildAssistToolSet`'s own wrapper never re-serializes
 * them. What this file adds is proof that the *dispatch* happens together -
 * a run log's call count, not an assertion about internal timing. */
function toolCallStep(
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
  u: FakeUsage = { inputTokens: 10, outputTokens: 5 },
): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...calls.map((c, i): LanguageModelV4StreamPart => ({
      type: 'tool-call',
      toolCallId: `c${i}-${c.name}`,
      toolName: c.name,
      input: JSON.stringify(c.args ?? {}),
    })),
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usage(u) },
  ];
}

/** The writing turn: an envelope-shaped final answer. */
function textStep(
  text: string,
  u: FakeUsage = { inputTokens: 10, outputTokens: 10 },
): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(u) },
  ];
}

/**
 * Wires a scripted model into the mocked registry for the next
 * `runSuggestion` call. `script(step, options)` runs once per model turn
 * (`step` 0-based) and returns that turn's stream parts - `options
 * .toolChoice` is what `SdkRunner`'s own budget enforcement sets once it
 * forces a turn text-only, and every budget-edge test below reads it from
 * here rather than guessing at timing. `modelPricing` defaults to an empty
 * catalogue (every existing test's cost stays null, pricing not being
 * their concern) - the cost-ceiling tests are the one caller that supplies
 * real per-token rates, since `SdkRunner`'s cost check is skipped
 * entirely (by design, same as `budgetRemainingUsd`) when pricing is
 * unknown.
 */
function useModel(
  script: (
    step: number,
    options: LanguageModelV4CallOptions,
  ) => LanguageModelV4StreamPart[] | Promise<LanguageModelV4StreamPart[]>,
  modelPricing: Array<{ id: string; pricing: { input: string; output: string } }> = [],
): { callCount: () => number } {
  let callIndex = 0;
  const model = (id: string) =>
    new MockLanguageModelV4({
      modelId: id,
      doStream: async (options) => {
        const step = callIndex++;
        const parts = await script(step, options);
        return { stream: convertArrayToReadableStream(parts) };
      },
    });
  const gateway = Object.assign(model, {
    getAvailableModels: async () => ({ models: modelPricing }),
  });
  // The one boundary cast in this file: `@ai-sdk/gateway`'s own
  // `GatewayProvider` type carries provider-specific extras `SdkRunner`
  // never reads - it only ever calls this as `(id) => LanguageModelV4` plus
  // `getAvailableModels`, both of which `gateway` above already provides.
  currentGatewayFn = (() => gateway) as unknown as typeof createGateway;
  return { callCount: () => callIndex };
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  currentGatewayFn = null;
  process.env.AI_GATEWAY_API_KEY = 'test-key';
  // The runner's model-catalogue cache is process-wide with a 5-minute TTL
  // by design (real deployments never re-fetch per run) - in this file's
  // test process that means an earlier test's plain, empty-catalogue
  // `useModel()` call would otherwise leak into a later test that supplies
  // real pricing via a different fake gateway, exactly the trap
  // `shared/tests/agents/sdk/runner.test.ts` already guards against (#574).
  __resetModelCatalogueCacheForTests();
}

async function seedOrgProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `p-${slug}`,
      name: slug,
      description: `about ${slug}`,
    })
    .returning();
  return { org, project };
}

function suggestionArgs(post: ObservedPost, orgId: number) {
  return {
    kind: 'post_comment' as const,
    post,
    persona: null,
    voiceProfile: null,
    projects: [],
    repos: [],
    orgId,
    runnerSlug: 'cloud',
  };
}

describe('runSuggestion: the agent loop (#566)', () => {
  beforeEach(reset);
  afterEach(() => {
    for (const dir of logDirs) rmSync(dir, { recursive: true, force: true });
    logDirs = [];
    vi.useRealTimers();
  });

  it('a suggestion needing the thread and the image takes multiple steps, dispatching independent tool calls together', async () => {
    const { org } = await seedOrgProject('org-loop-multistep');
    // Captured at the write step (the one whose prompt already carries every
    // earlier tool result) so the assertions below can check the *results*
    // actually reached the model - a step count alone cannot tell "the
    // tools genuinely ran" apart from "the harness pretended they did", since
    // `ai` forwards an unexecutable tool-call through to the next turn
    // either way.
    let finalPrompt = '';
    const { callCount } = useModel((step, options) => {
      if (step === 0) return toolCallStep([{ name: 'read_thread' }, { name: 'author_history' }]);
      if (step === 1) return toolCallStep([{ name: 'look_at_image' }]);
      finalPrompt = JSON.stringify(options.prompt);
      return textStep(
        `Noticed the chart.\n${DRAFT_MARKER}\nGreat point on p99, thanks for the context.`,
      );
    });

    const handle = runSuggestion(
      suggestionArgs(
        {
          urn: 'urn:li:activity:2',
          authorHandle: 'jdoe',
          authorName: 'J Doe',
          text: 'We cut p99 in half this week.',
          thread: {
            comments: [{ body: 'Nice work', authorHandle: 'other-user' }],
            renderedCount: 1,
            truncated: false,
          },
          image: { alt: 'A latency chart trending down', kind: 'image' },
        },
        org.id,
      ),
    );
    const result = await handle.result;

    // Two independent, DB-backed tools requested in the same step (step 0),
    // then look_at_image alone (step 1, per the design's "runs alone"), then
    // the write (step 2) - three model turns, not four: if the two tools in
    // step 0 had been forced into separate turns instead of dispatched
    // together, this would read 4.
    expect(callCount()).toBe(3);
    expect(result.draft).toBe('Great point on p99, thanks for the context.');
    // The real handlers actually ran and their real answers reached the
    // write step - read_thread's real comment text, author_history's real
    // "nothing on file" refusal (a fresh org has no contact_history row for
    // this handle), and look_at_image's real alt-text description.
    expect(finalPrompt).toContain('Nice work');
    expect(finalPrompt).toContain('no prior contact');
    expect(finalPrompt).toContain('A latency chart trending down');
  });

  it('a plain text post still takes exactly one model turn when the model asks for no tools', async () => {
    const { org } = await seedOrgProject('org-loop-singleturn');
    const { callCount } = useModel(() =>
      textStep(`Straightforward.\n${DRAFT_MARKER}\nCongrats on shipping this.`),
    );

    const handle = runSuggestion(
      suggestionArgs(
        { urn: 'urn:li:activity:3', authorName: 'A', text: 'Shipped a small thing today.' },
        org.id,
      ),
    );
    const result = await handle.result;

    expect(callCount()).toBe(1);
    expect(result.draft).toBe('Congrats on shipping this.');
  });

  it('cancelling from the panel stops the loop mid-step: no further tool handler starts and no further model turn is requested', async () => {
    const { org } = await seedOrgProject('org-loop-cancel');
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const { callCount } = useModel(async (step, options) => {
      if (step > 0) {
        throw new Error(`no further model turn should have been requested (reached step ${step})`);
      }
      resolveStarted();
      // The real AI SDK ends the stream cleanly on abort rather than
      // throwing (docs/cloud-runner.md's "an aborted streamText does not
      // throw" finding) - waiting on the signal and yielding nothing models
      // that faithfully.
      await waitForAbort(options.abortSignal ?? new AbortController().signal);
      return [];
    });

    const handle = runSuggestion(
      suggestionArgs({ urn: 'urn:li:activity:4', authorName: 'A', text: 'hi' }, org.id),
    );
    await started;
    handle.cancel();

    await expect(handle.result).rejects.toThrow(/cancelled/i);
    expect(callCount()).toBe(1);
  });

  it('hitting the step budget forces the model to answer with what it has, yielding a usable draft', async () => {
    const { org } = await seedOrgProject('org-loop-steps');
    const { callCount } = useModel((_step, options) => {
      if (options.toolChoice?.type === 'none') {
        return textStep(`Wrapping up.\n${DRAFT_MARKER}\nHere is what I found in time.`);
      }
      return toolCallStep([{ name: 'check_style', args: { text: 'a draft in progress' } }]);
    });

    const handle = runSuggestion(
      suggestionArgs({ urn: 'urn:li:activity:5', authorName: 'A', text: 'hi' }, org.id),
    );
    const result = await handle.result;

    // Steps 0..ASSIST_MAX_STEPS-2 are free to call tools; the last one
    // (index ASSIST_MAX_STEPS-1) is forced text-only - ASSIST_MAX_STEPS
    // turns total.
    expect(callCount()).toBe(ASSIST_MAX_STEPS);
    expect(result.draft).toBe('Here is what I found in time.');
  });

  it('crossing the soft wall-clock budget forces the model to answer with what it has, yielding a usable draft', async () => {
    vi.useFakeTimers();
    const { org } = await seedOrgProject('org-loop-soft');
    const { callCount } = useModel(async (_step, options) => {
      if (options.toolChoice?.type === 'none') {
        return textStep(`Time is up.\n${DRAFT_MARKER}\nHere is my answer given the time I had.`);
      }
      // The first turn itself takes longer than the soft budget - the very
      // next prepareStep call then sees elapsed wall-clock time already
      // past it.
      await vi.advanceTimersByTimeAsync(ASSIST_SOFT_BUDGET_MS + 1_000);
      return toolCallStep([{ name: 'check_style', args: { text: 'a draft in progress' } }]);
    });

    const handle = runSuggestion(
      suggestionArgs({ urn: 'urn:li:activity:6', authorName: 'A', text: 'hi' }, org.id),
    );
    const result = await handle.result;

    expect(callCount()).toBe(2);
    expect(result.draft).toBe('Here is my answer given the time I had.');
  });

  it('crossing the token budget forces the model to answer with what it has, yielding a usable draft', async () => {
    const { org } = await seedOrgProject('org-loop-tokens');
    const { callCount } = useModel((_step, options) => {
      if (options.toolChoice?.type === 'none') {
        return textStep(
          `Enough context.\n${DRAFT_MARKER}\nHere is my answer from what I already gathered.`,
        );
      }
      // Step 0 alone reports more input tokens than ASSIST_TOKEN_BUDGET, so
      // step 1's prepareStep sees the accumulated total already over it.
      return toolCallStep([{ name: 'check_style', args: { text: 'a draft in progress' } }], {
        inputTokens: ASSIST_TOKEN_BUDGET + 10_000,
        outputTokens: 5,
      });
    });

    const handle = runSuggestion(
      suggestionArgs({ urn: 'urn:li:activity:7', authorName: 'A', text: 'hi' }, org.id),
    );
    const result = await handle.result;

    expect(callCount()).toBe(2);
    expect(result.draft).toBe('Here is my answer from what I already gathered.');
  });

  it('crossing the cost ceiling forces the model to answer with what it has, yielding a usable draft', async () => {
    const { org } = await seedOrgProject('org-loop-cost');
    useModel(
      (_step, options) => {
        if (options.toolChoice?.type === 'none') {
          return textStep(
            `Budget spent.\n${DRAFT_MARKER}\nHere is my answer given what it already cost.`,
          );
        }
        // 30,000 input + 1,000 output tokens at $0.00002/token = $0.62,
        // comfortably over ASSIST_COST_CEILING_USD ($0.50) and well under
        // ASSIST_TOKEN_BUDGET (60,000) - isolates the cost ceiling as the
        // one that trips here, not the token budget (#574).
        return toolCallStep([{ name: 'check_style', args: { text: 'a draft in progress' } }], {
          inputTokens: 30_000,
          outputTokens: 1_000,
        });
      },
      [{ id: 'google/gemini-3.1-flash-lite', pricing: { input: '0.00002', output: '0.00002' } }],
    );

    const handle = runSuggestion(
      suggestionArgs({ urn: 'urn:li:activity:9', authorName: 'A', text: 'hi' }, org.id),
    );
    const result = await handle.result;

    expect(result.draft).toBe('Here is my answer given what it already cost.');
    // The mock's raw `doStream` invocation count (`callCount()`) is a proxy
    // for "the ceiling stopped the loop after one tool-call step", and it
    // only holds if that accounting arrives before the next step is taken -
    // under load (LOR-204) a retried/delayed invocation can inflate it
    // without an extra step actually having run. The loop's own published
    // usage total is the real record: exactly one 30k/1k tool-call step
    // plus the forced 10/10 text turn, never a second tool-call step's
    // worth on top.
    expect(result.usage?.inputTokens).toBe(30_010);
    expect(result.usage?.outputTokens).toBe(1_010);
  });

  it('a normal multi-step suggestion completes on its own - real pricing wired keeps the cost ceiling from forcing an early answer', async () => {
    const { org } = await seedOrgProject('org-loop-cost-cheap');
    const { callCount } = useModel(
      (step, options) => {
        if (options.toolChoice?.type === 'none') {
          // Only reached if something forced text-only early - what tells
          // an incorrectly-tripped ceiling apart from the assertions below.
          return textStep(`Forced.\n${DRAFT_MARKER}\nCut short.`);
        }
        if (step === 0) {
          return toolCallStep([{ name: 'read_thread' }], { inputTokens: 2_600, outputTokens: 40 });
        }
        if (step === 1) {
          return toolCallStep([{ name: 'author_history' }], {
            inputTokens: 4_100,
            outputTokens: 40,
          });
        }
        // House-style-clean (no filler opener, no wrap-up closer, no
        // puffery) so the deterministic style checker never triggers its
        // own extra model round trip (#572) and confuses this test's own
        // call count with a different mechanism's.
        return textStep(
          `Two real tool calls, still cheap.\n${DRAFT_MARKER}\nGood to see this land, especially the p99 improvement.`,
          { inputTokens: 4_962, outputTokens: 210 },
        );
      },
      // The fast default's real derived rate (SSH-verified against the
      // preview database, #574's own PR) - unlike every other test above,
      // this one wires real pricing so the cost check actually runs.
      [
        {
          id: 'google/gemini-3.1-flash-lite',
          pricing: { input: '0.0000003087', output: '0.0000006860' },
        },
      ],
    );

    const handle = runSuggestion(
      suggestionArgs(
        {
          urn: 'urn:li:activity:10',
          authorName: 'A',
          text: 'hi',
          thread: { comments: [{ body: 'nice' }], renderedCount: 1, truncated: false },
        },
        org.id,
      ),
    );
    const result = await handle.result;

    // Three natural turns (two independent tool calls, then the write) -
    // real per-token pricing is wired, but this token profile stays two
    // orders of magnitude under ASSIST_COST_CEILING_USD, so it never forces
    // the early, generic "Forced/Cut short" answer above.
    expect(callCount()).toBe(3);
    expect(result.draft).toBe('Good to see this land, especially the p99 improvement.');
    // `costUsd` is `number | null` by design (`RunUsageResult` in
    // shared/src/agents/sdk/event-normalizer.ts) - null only when the run's
    // model has no catalogue pricing, which real pricing for
    // `google/gemini-3.1-flash-lite` is wired above to rule out. Asserted
    // separately from the bound below on purpose: `.toBeLessThan(null)`
    // throws "received object" (`typeof null === 'object'` in JS, verified
    // against this exact vitest matcher - LOR-204), which reads as a shape
    // mismatch rather than the real, more diagnosable failure - pricing not
    // found for the wired model.
    expect(result.usage?.costUsd).not.toBeNull();
    expect(result.usage?.costUsd as number).toBeLessThan(ASSIST_COST_CEILING_USD / 10);
  });

  it('usage is the sum across steps, not just the last one', async () => {
    const { org } = await seedOrgProject('org-loop-usage');
    useModel((step) => {
      if (step === 0) {
        return toolCallStep([{ name: 'check_style', args: { text: 'draft' } }], {
          inputTokens: 30,
          outputTokens: 5,
        });
      }
      return textStep(`Ok.\n${DRAFT_MARKER}\nFinal answer.`, { inputTokens: 20, outputTokens: 15 });
    });

    const handle = runSuggestion(
      suggestionArgs({ urn: 'urn:li:activity:8', authorName: 'A', text: 'hi' }, org.id),
    );
    const result = await handle.result;

    expect(result.usage?.inputTokens).toBe(50);
    expect(result.usage?.outputTokens).toBe(20);
    // No catalogue pricing wired into this fake gateway - cost stays
    // best-effort null rather than a guess, per the design doc.
    expect(result.usage?.costUsd).toBeNull();
  });
});
