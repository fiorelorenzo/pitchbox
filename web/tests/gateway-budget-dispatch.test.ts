// #419: while the runner used my subscription, an org's spend was bounded by
// a quota claim minted into a session JWT that the (now-gone) prodbox runner
// service enforced. The SDK runner spends against the product's own Gateway
// key instead, so the meter has to live on this side: dispatchRun refuses a
// 'cloud' run before it starts once the org has no budget left, and passes
// the remaining budget down so SdkRunner can stop mid-stream too (covered by
// shared/tests/agents/sdk/runner.test.ts). This file proves the admission
// check and the cost bookkeeping through the real dispatch path
// (runCampaign -> dispatchRun), not against org-quota.ts's helpers directly.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { getOrgMonthToDateCostUsd } from '@pitchbox/shared/org-quota';
import type {
  AgentRunHandle,
  AgentRunOptions,
  AgentRunner,
  AgentRunResult,
} from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { subscribe } from '../src/lib/server/events.js';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';

let capturedOpts: AgentRunOptions | null = null;
let createCalls = 0;
let fakeResult: AgentRunResult = { exitCode: 0, logPath: '/dev/null' };

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'cloud',
    run(opts: AgentRunOptions): AgentRunHandle {
      createCalls += 1;
      capturedOpts = opts;
      return { result: Promise.resolve(fakeResult), cancel: () => {} };
    },
  }),
}));

// Dynamic on purpose - vi.mock above is hoisted, but runner.js has to load
// after it for createAgentRunner to resolve to the fake gateway runner
// (same pattern as extension-suggest.test.ts / extension-suggest-voice.test.ts).
const { runCampaign } = await import('../src/lib/server/runner.js');

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  capturedOpts = null;
  createCalls = 0;
  fakeResult = { exitCode: 0, logPath: '/dev/null' };
}

async function platformId(slug: string): Promise<number> {
  const [platform] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  if (!platform) throw new Error(`platform "${slug}" is not seeded - did global-setup run?`);
  return platform.id;
}

/** A 'cloud'-runner campaign under an org with the given monthly budget. */
async function seedCloudCampaign(
  slug: string,
  monthlyRunBudgetUsd: string | null,
): Promise<{ orgId: number; campaignId: number }> {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, monthlyRunBudgetUsd })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${slug}-proj`,
      name: `${slug} p`,
      defaultAgentRunner: 'cloud',
    })
    .returning();
  const platform = await platformId('reddit');
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform,
      name: 'c',
      skillSlug: 'reddit-scout',
      agentRunner: 'cloud',
    })
    .returning();
  return { orgId: org.id, campaignId: campaign.id };
}

async function runRow(runId: number) {
  const [row] = await getDb()
    .select({
      status: schema.runs.status,
      error: schema.runs.error,
      failureReason: schema.runs.failureReason,
      costUsd: schema.runs.costUsd,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));
  return row;
}

/** dispatchRun's completion write runs off `handle.result`'s own promise
 * chain, outside runCampaign's own await for a real dispatch - `run:finished`
 * is emitted right after that write, on the realtime bus every SSE client
 * already relies on, so subscribing to it is the actual completion signal
 * rather than a guessed delay. A pre-flight refusal (the org already over
 * budget) never reaches this: it fails synchronously inside runCampaign's
 * own await, before dispatchRun even calls the runner. */
function waitForRunFinished(orgId: number): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribe(orgId, (evt) => {
      if (evt.kind !== 'run:finished') return;
      unsubscribe();
      resolve();
    });
  });
}

describe('cloud run dispatch is budget-gated (#419)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  const savedRunnerUrl = process.env.PITCHBOX_RUNNER_URL;

  beforeEach(async () => {
    await reset();
    // shared/src/agents/detect.ts's cloud probe is still wired to the old
    // WS-runner's isCloudRunnerEnabled() (PITCHBOX_EDITION + a runner URL) -
    // stale since #416 repointed the 'cloud' slug at SdkRunner, which needs
    // neither. Flagged to #420 (owns that file); worked around here so
    // dispatch reaches the registry-mocked runner instead of being refused
    // for an unrelated reason before my own budget check is ever exercised.
    process.env.PITCHBOX_EDITION = 'cloud';
    process.env.PITCHBOX_RUNNER_URL = 'ws://fake-runner.test';
    clearDetectionCache();
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    if (savedRunnerUrl === undefined) delete process.env.PITCHBOX_RUNNER_URL;
    else process.env.PITCHBOX_RUNNER_URL = savedRunnerUrl;
    clearDetectionCache();
  });

  it('refuses to start once the org has no budget left, and tells the caller why - through the real dispatch path', async () => {
    const { campaignId } = await seedCloudCampaign('gw-over-budget', '0.00');

    const started = Date.now();
    const { runId } = await runCampaign(campaignId);
    const run = await runRow(runId);

    // Refused before ever reaching createAgentRunner - not a downstream
    // failure that happened to also be about budget.
    expect(createCalls).toBe(0);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/over its monthly.*quota/i);
    expect(run?.error).toMatch(/\$0\.00/);
    expect(run?.failureReason).toBe('quota_exhausted');
    // The bug this guards against is a real dispatch attempt (network,
    // process spawn) before finding out the org can't afford it; the guard
    // itself is a DB read plus a synchronous check.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lets a run start when the org is under budget, and hands the runner its exact remaining budget', async () => {
    const { orgId, campaignId } = await seedCloudCampaign('gw-under-budget', '10.00');

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignId);
    await finished;

    expect(createCalls).toBe(1);
    expect(capturedOpts?.budgetRemainingUsd).toBe(10);
    expect((await runRow(runId))?.status).not.toBe('running');
  });

  it("persists the SDK runner's own reported cost, and getOrgMonthToDateCostUsd agrees with it exactly", async () => {
    const { orgId, campaignId } = await seedCloudCampaign('gw-cost-sum', '10.00');
    fakeResult = {
      exitCode: 0,
      logPath: '/dev/null',
      tokensUsed: 400,
      usage: {
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 2.5,
        costReported: true,
      },
    };

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignId);
    await finished;

    const run = await runRow(runId);
    expect(Number(run?.costUsd)).toBeCloseTo(2.5, 4);
    // Not the same call as the write above: this re-reads via the exact
    // helper the dashboard and the org-quota settings page call, proving the
    // two never diverge rather than just re-asserting the row we just wrote.
    const monthToDate = await getOrgMonthToDateCostUsd(getDb(), orgId);
    expect(monthToDate).toBeCloseTo(2.5, 4);
  });

  it('a second run is refused once the first pushed the org over budget', async () => {
    const { orgId, campaignId } = await seedCloudCampaign('gw-second-run', '2.00');
    fakeResult = {
      exitCode: 0,
      logPath: '/dev/null',
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 3, // over the $2.00 budget by itself
        costReported: true,
      },
    };
    const firstFinished = waitForRunFinished(orgId);
    await runCampaign(campaignId);
    await firstFinished;
    expect(createCalls).toBe(1);

    const second = await runCampaign(campaignId);
    const secondRun = await runRow(second.runId);
    expect(createCalls).toBe(1); // still 1 - the second dispatch never reached it
    expect(secondRun?.status).toBe('failed');
    expect(secondRun?.failureReason).toBe('quota_exhausted');

    const monthToDate = await getOrgMonthToDateCostUsd(getDb(), orgId);
    expect(monthToDate).toBeCloseTo(3, 4);
  });
});
