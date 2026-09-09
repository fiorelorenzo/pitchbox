// #540: opening registration to strangers (#423) turns a per-org cap into an
// unbounded instance-wide one - a hundred self-registered orgs each safely
// under their own budget still sums to a real bill nobody capped. This file
// proves the instance-wide ceiling refuses a dispatch through the real path
// (runCampaign -> dispatchRun), exercised across a SECOND organization
// rather than by asserting on getInstanceQuotaSnapshot's return value
// directly: an org whose own budget is fine still gets refused once some
// other org's spend has pushed the instance-wide total over the ceiling,
// and with its own distinct reason (instance_quota_exhausted), never the
// per-org quota_exhausted.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  saveInstanceQuotaCeiling,
  getInstanceMonthToDateCostUsd,
} from '@pitchbox/shared/org-quota';
import type {
  AgentRunHandle,
  AgentRunOptions,
  AgentRunner,
  AgentRunResult,
} from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { subscribe } from '../src/lib/server/events.js';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';

let createCalls = 0;
let fakeResult: AgentRunResult = { exitCode: 0, logPath: '/dev/null' };

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'cloud',
    run(_opts: AgentRunOptions): AgentRunHandle {
      createCalls += 1;
      return { result: Promise.resolve(fakeResult), cancel: () => {} };
    },
  }),
}));

// Dynamic on purpose - vi.mock above is hoisted, same pattern as
// gateway-budget-dispatch.test.ts.
const { runCampaign } = await import('../src/lib/server/runner.js');

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
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

/** A 'cloud'-runner campaign under an org with the given monthly budget (or
 * unlimited, when omitted) - its own per-org axis, kept generous throughout
 * this file since every test here is about the instance-wide axis instead. */
async function seedCloudCampaign(
  slug: string,
  monthlyRunBudgetUsd: string | null = null,
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
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));
  return row;
}

function waitForRunFinished(orgId: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = subscribe(orgId, (evt) => {
    if (evt.kind !== 'run:finished') return;
    unsubscribe();
    resolve();
  });
  return promise;
}

describe('cloud run dispatch is instance-wide-ceiling-gated (#540)', () => {
  const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(async () => {
    await reset();
    process.env.AI_GATEWAY_API_KEY = 'test-key';
    clearDetectionCache();
  });
  afterEach(() => {
    if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
    clearDetectionCache();
  });

  it("refuses a second organization's run once a first organization's spend pushed the instance ceiling over, even though the second organization's own budget is fine", async () => {
    await saveInstanceQuotaCeiling(getDb(), { monthlyBudgetUsd: 2 });

    // Org A spends $3, over the $2 instance ceiling by itself - its own
    // budget is unlimited (null), so nothing on its axis would refuse this.
    const orgA = await seedCloudCampaign('inst-ceiling-org-a');
    fakeResult = {
      exitCode: 0,
      logPath: '/dev/null',
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 3,
        costReported: true,
      },
    };
    const aFinished = waitForRunFinished(orgA.orgId);
    await runCampaign(orgA.campaignId);
    await aFinished;
    expect(createCalls).toBe(1);

    const instanceTotal = await getInstanceMonthToDateCostUsd(getDb());
    expect(instanceTotal).toBeCloseTo(3, 4);

    // Org B is a completely different organization with its own unlimited
    // per-org budget - the only thing that can refuse it is the
    // instance-wide ceiling org A's spend already crossed.
    const orgB = await seedCloudCampaign('inst-ceiling-org-b');
    const started = Date.now();
    const { runId } = await runCampaign(orgB.campaignId);
    const run = await runRow(runId);

    // Refused before ever reaching createAgentRunner a second time - not a
    // downstream failure, and not org B's own budget (it has none).
    expect(createCalls).toBe(1);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/instance-wide monthly.*ceiling/i);
    expect(run?.error).not.toMatch(/quota/i);
    expect(run?.failureReason).toBe('instance_quota_exhausted');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lets a run start when the instance total is still under the ceiling', async () => {
    await saveInstanceQuotaCeiling(getDb(), { monthlyBudgetUsd: 100 });
    const { orgId, campaignId } = await seedCloudCampaign('inst-ceiling-under');

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignId);
    await finished;

    expect(createCalls).toBe(1);
    expect((await runRow(runId))?.status).not.toBe('running');
  });

  it('treats an explicit null ceiling as unlimited, never refusing on the instance axis', async () => {
    await saveInstanceQuotaCeiling(getDb(), { monthlyBudgetUsd: null });
    const orgA = await seedCloudCampaign('inst-ceiling-unlimited-a');
    fakeResult = {
      exitCode: 0,
      logPath: '/dev/null',
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 1_000,
        costReported: true,
      },
    };
    const aFinished = waitForRunFinished(orgA.orgId);
    await runCampaign(orgA.campaignId);
    await aFinished;

    const orgB = await seedCloudCampaign('inst-ceiling-unlimited-b');
    const bFinished = waitForRunFinished(orgB.orgId);
    const { runId } = await runCampaign(orgB.campaignId);
    await bFinished;

    // Neither dispatch was pre-empted by the instance-wide check (both
    // reached createAgentRunner) - the terminal status itself is
    // irrelevant here, since the fake runner never creates a draft and so
    // always ends in playbook_incomplete downstream of the budget gate,
    // same as the sibling budget-dispatch suite's "under budget" case.
    expect(createCalls).toBe(2);
    expect((await runRow(runId))?.status).not.toBe('running');
  });
});
