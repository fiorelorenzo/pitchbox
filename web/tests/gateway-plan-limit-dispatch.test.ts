// #548: every plan limit is refused where the effect happens. This file
// proves the run-count ceiling (shared/src/plans.ts's `runsPerMonth`)
// through the real dispatch path (runCampaign -> dispatchRun), the same way
// gateway-budget-dispatch.test.ts proves the Gateway budget - a distinct
// axis, checked separately, with its own `plan_limit_reached` failure
// reason so a reader of `runs.failure_reason` can tell "the plan ran out"
// from "the budget ran out" (quota_exhausted) or "too many runs are already
// going" (concurrency_exhausted).
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';
import type {
  AgentRunHandle,
  AgentRunOptions,
  AgentRunner,
  AgentRunResult,
} from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';
import { subscribe } from '../src/lib/server/events.js';

let createCalls = 0;
const fakeResult: AgentRunResult = { exitCode: 0, logPath: '/dev/null' };

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'cloud',
    run(_opts: AgentRunOptions): AgentRunHandle {
      createCalls += 1;
      return { result: Promise.resolve(fakeResult), cancel: () => {} };
    },
  }),
}));

// Dynamic on purpose - vi.mock above is hoisted, but runner.js has to load
// after it for createAgentRunner to resolve to the fake gateway runner
// (same pattern as gateway-budget-dispatch.test.ts).
const { runCampaign } = await import('../src/lib/server/runner.js');

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  createCalls = 0;
}

async function platformId(slug: string): Promise<number> {
  const [platform] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  if (!platform) throw new Error(`platform "${slug}" is not seeded - did global-setup run?`);
  return platform.id;
}

/** A 'cloud'-runner campaign under an org on `plan`, with `existingRuns`
 * already recorded against it this period before the campaign this test
 * dispatches. */
async function seedCloudCampaign(
  slug: string,
  opts: { plan?: string; existingRuns?: number } = {},
): Promise<{ orgId: number; projectId: number; campaignId: number }> {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: opts.plan ?? 'free' })
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
  for (let i = 0; i < (opts.existingRuns ?? 0); i += 1) {
    await db.insert(schema.runs).values({
      kind: 'project_extraction',
      projectId: project.id,
      trigger: 'manual',
      status: 'success',
      startedAt: new Date(),
    });
  }
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
  return { orgId: org.id, projectId: project.id, campaignId: campaign.id };
}

async function runRow(runId: number) {
  const [row] = await getDb()
    .select({
      status: schema.runs.status,
      error: schema.runs.error,
      failureReason: schema.runs.failureReason,
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
 * its plan limit) never reaches this: it fails synchronously inside
 * runCampaign's own await, before dispatchRun ever calls the runner. Every
 * test below that admits the run (createCalls becomes 1) has to wait on
 * this before it ends, or dispatchRun's background write (including its
 * `assist_usage`-shaped notify() on a later failure) can still be running
 * when the next file's `TRUNCATE ... CASCADE` truncates the org it's
 * writing to - see #616.
 */
function waitForRunFinished(orgId: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = subscribe(orgId, (evt) => {
    if (evt.kind !== 'run:finished') return;
    unsubscribe();
    resolve();
  });
  return promise;
}

describe('cloud run dispatch is plan-run-count-gated (#548)', () => {
  const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;
  const savedEdition = process.env.PITCHBOX_EDITION;

  beforeEach(async () => {
    await reset();
    process.env.AI_GATEWAY_API_KEY = 'test-key';
    process.env.PITCHBOX_EDITION = 'cloud';
    clearDetectionCache();
  });
  afterEach(() => {
    if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    clearDetectionCache();
  });

  const freeLimit = PLAN_CATALOGUE.free.runsPerMonth!;

  it('refuses a run once the org has already used its whole plan allowance this period', async () => {
    const { campaignId } = await seedCloudCampaign('plan-limit-over', {
      plan: 'free',
      existingRuns: freeLimit, // this dispatch's own row would be the (limit + 1)th
    });

    const { runId } = await runCampaign(campaignId);
    const run = await runRow(runId);

    expect(createCalls).toBe(0); // refused before the runner was ever created
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/plan limit/i);
    expect(run?.error).not.toMatch(/quota|concurrency/i);
    expect(run?.failureReason).toBe('plan_limit_reached');
  });

  it('admits a run when it is exactly the last one the plan allows this period', async () => {
    const { orgId, campaignId } = await seedCloudCampaign('plan-limit-exact', {
      plan: 'free',
      existingRuns: freeLimit - 1, // this dispatch's own row makes exactly `limit`
    });

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignId);
    await finished;
    const run = await runRow(runId);

    expect(createCalls).toBe(1);
    // The fake runner never creates a draft or calls run:finish, so
    // dispatchRun's own "ended its turn without creating a draft" check
    // marks the run failed once it settles - same posture as
    // gateway-budget-dispatch.test.ts's identical fake. What this test
    // proves is admission (the plan-limit gate let it reach the runner at
    // all), not agent completion semantics.
    expect(run?.status).not.toBe('running');
  });

  it('an org well under its plan limit proceeds normally', async () => {
    const { orgId, campaignId } = await seedCloudCampaign('plan-limit-under', {
      plan: 'free',
      existingRuns: 2,
    });

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignId);
    await finished;
    const run = await runRow(runId);

    expect(createCalls).toBe(1);
    expect(run?.status).not.toBe('running');
  });

  // The regression that would make this feature unshippable: a self-host
  // install must never be refused, however many runs it has recorded.
  it('a self-host install refuses nothing, however many runs the org already has this period', async () => {
    delete process.env.PITCHBOX_EDITION;
    const { orgId, campaignId } = await seedCloudCampaign('plan-limit-self-host', {
      plan: 'free',
      existingRuns: freeLimit + 50, // wildly over the free plan's count
    });

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignId);
    await finished;
    const run = await runRow(runId);

    expect(createCalls).toBe(1);
    expect(run?.status).not.toBe('running');
  });
});
