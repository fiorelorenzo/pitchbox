// #485: organizations.max_concurrent_runs went unenforced once the old
// runner service's in-memory per-org session map disappeared with it
// (#420) - an org could start as many simultaneous cloud runs as it could
// trigger, each spending real money against the product's own Gateway key.
// dispatchRun now refuses a 'cloud' run before it starts once the org is
// already at its concurrency cap, via shared/src/org-quota.ts's
// assertOrgConcurrencyAdmitted. This file proves that admission check
// through the real dispatch path (runCampaign -> dispatchRun), not against
// org-quota.ts's helper directly, and proves the race is actually closed
// with genuinely concurrent dispatches against one real database - see
// gateway-budget-dispatch.test.ts (#419) for the budget-side sibling this
// mirrors, and shared/tests/org-quota.test.ts for a lower-level, more
// exhaustive proof of the locking mechanism itself.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import type {
  AgentRunHandle,
  AgentRunOptions,
  AgentRunner,
  AgentRunResult,
} from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { subscribe } from '../src/lib/server/events.js';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';

let capturedOpts: AgentRunOptions[] = [];
let createCalls = 0;
let fakeResult: AgentRunResult = { exitCode: 0, logPath: '/dev/null' };
// Set by a test to make the NEXT dispatched run's underlying "agent" hang
// forever (never resolve), so that run stays 'running' for the rest of the
// test - the concurrency-boundary tests need a slot genuinely occupied,
// not a DB row hand-inserted as 'running' behind the real dispatch path's
// back. `Promise.withResolvers()` gives a promise with no scheduled
// settlement rather than a `new Promise` executor that never calls its
// callback.
let pendingHold: Promise<AgentRunResult> | null = null;

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'cloud',
    run(opts: AgentRunOptions): AgentRunHandle {
      createCalls += 1;
      capturedOpts.push(opts);
      return { result: pendingHold ?? Promise.resolve(fakeResult), cancel: () => {} };
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
  capturedOpts = [];
  createCalls = 0;
  fakeResult = { exitCode: 0, logPath: '/dev/null' };
  pendingHold = null;
}

async function platformId(slug: string): Promise<number> {
  const [platform] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  if (!platform) throw new Error(`platform "${slug}" is not seeded - did global-setup run?`);
  return platform.id;
}

/** An org with the given `max_concurrent_runs`, one project, and `count`
 * separate 'cloud'-runner campaigns under it (separate campaigns so a race
 * between them never collides with `runs_one_running_per_campaign` - the
 * cap under test here is the org-level one, not the per-campaign one). */
async function seedCloudOrg(
  slug: string,
  maxConcurrentRuns: number | null,
  count: number,
): Promise<{ orgId: number; campaignIds: number[] }> {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, maxConcurrentRuns })
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
  const campaignIds: number[] = [];
  for (let i = 0; i < count; i++) {
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform,
        name: `c${i}`,
        skillSlug: 'reddit-scout',
        agentRunner: 'cloud',
      })
      .returning();
    campaignIds.push(campaign.id);
  }
  return { orgId: org.id, campaignIds };
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
 * chain, outside runCampaign's own await for a real dispatch (see
 * gateway-budget-dispatch.test.ts) - `run:finished` on the realtime bus is
 * the actual completion signal. */
function waitForRunFinished(orgId: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = subscribe(orgId, (evt) => {
    if (evt.kind !== 'run:finished') return;
    unsubscribe();
    resolve();
  });
  return promise;
}

describe('cloud run dispatch is concurrency-capped (#485)', () => {
  const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(async () => {
    await reset();
    // shared/src/agents/detect.ts's cloud probe gates purely on
    // AI_GATEWAY_API_KEY being configured - vitest.config.ts blanks it for
    // every test so a developer's real key never leaks into a test run.
    process.env.AI_GATEWAY_API_KEY = 'test-key';
    clearDetectionCache();
  });
  afterEach(() => {
    if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
    clearDetectionCache();
  });

  it('refuses to start once the org is already at its concurrency cap, and tells the caller why - through the real dispatch path', async () => {
    const { campaignIds } = await seedCloudOrg('conc-at-cap', 1, 2);

    // Occupy the org's only slot with a genuinely dispatched run whose
    // underlying agent never finishes, so it stays 'running' for the rest
    // of the test. runCampaign itself still resolves as soon as the run is
    // dispatched (its own completion write runs off the handle's promise
    // chain, not this await), so no sleep is needed to "let it land".
    pendingHold = Promise.withResolvers<AgentRunResult>().promise;
    await runCampaign(campaignIds[0]);
    expect(createCalls).toBe(1);
    pendingHold = null;

    const started = Date.now();
    const { runId } = await runCampaign(campaignIds[1]);
    const run = await runRow(runId);

    // Refused before ever reaching createAgentRunner for the second
    // campaign - not a downstream failure that happened to also be about
    // concurrency.
    expect(createCalls).toBe(1);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/concurrency limit/i);
    expect(run?.error).not.toMatch(/quota|rate.limit/i);
    expect(run?.failureReason).toBe('concurrency_exhausted');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lets a run start once the org is under its concurrency cap', async () => {
    const { orgId, campaignIds } = await seedCloudOrg('conc-under-cap', 2, 1);

    const finished = waitForRunFinished(orgId);
    const { runId } = await runCampaign(campaignIds[0]);
    await finished;

    expect(createCalls).toBe(1);
    expect((await runRow(runId))?.status).not.toBe('running');
  });

  it('is never capped when max_concurrent_runs is unset (unlimited)', async () => {
    const { orgId, campaignIds } = await seedCloudOrg('conc-unlimited', null, 3);

    const results = await Promise.all(campaignIds.map((id) => runCampaign(id)));
    await Promise.all(results.map(() => waitForRunFinished(orgId)));

    expect(createCalls).toBe(3);
    for (const { runId } of results) {
      expect((await runRow(runId))?.status).not.toBe('running');
    }
  });

  // The actual bug (#485): a count-then-insert race between two dispatches
  // for the same org. Fired as genuinely concurrent promises against one
  // real Postgres (runCampaign -> dispatchRun for two DIFFERENT campaigns
  // under the same org, so runs_one_running_per_campaign's own per-campaign
  // uniqueness can't be what's blocking the second one), not two sequential
  // awaits - a sequential pair would trivially pass even with no admission
  // check at all.
  it('two dispatches racing at the concurrency boundary cannot both win', async () => {
    const { campaignIds } = await seedCloudOrg('conc-race', 1, 2);

    const [first, second] = await Promise.all([
      runCampaign(campaignIds[0]),
      runCampaign(campaignIds[1]),
    ]);
    const [firstRun, secondRun] = await Promise.all([runRow(first.runId), runRow(second.runId)]);

    // Exactly one reached the runner (createCalls); the other was refused
    // at the concurrency pre-flight before ever spawning one. Distinguish
    // "admitted" from "refused" by `failureReason`, not by the winner's own
    // eventual status - the mocked agent's run can still fail afterward for
    // reasons that have nothing to do with #485 (e.g. the run-completion
    // contract in web/src/lib/server/runner.ts, unrelated to this check),
    // and asserting a bare 'success' here would make this test depend on
    // that unrelated contract too. Both racers being admitted (both
    // createCalls, neither carrying `concurrency_exhausted`) is exactly the
    // bug #485 reported.
    expect(createCalls).toBe(1);
    const refused = [firstRun, secondRun].filter(
      (r) => r?.failureReason === 'concurrency_exhausted',
    );
    const admitted = [firstRun, secondRun].filter(
      (r) => r?.failureReason !== 'concurrency_exhausted',
    );
    expect(refused).toHaveLength(1);
    expect(admitted).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/concurrency limit/i);
  });
});
