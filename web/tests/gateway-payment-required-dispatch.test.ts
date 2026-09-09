// #554: a failed payment past its grace window is refused where the effect
// happens, exactly like #548's plan-limit ceiling (gateway-plan-limit-dispatch.test.ts)
// but with its own `plan_payment_required` failure reason, since "fix your
// payment in the portal" is a different fix than "wait or upgrade".
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import type {
  AgentRunHandle,
  AgentRunOptions,
  AgentRunner,
  AgentRunResult,
} from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';
import { clearDetectionCache } from '@pitchbox/shared/agents/detect';

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
// after it for createAgentRunner to resolve to the fake gateway runner.
const { runCampaign } = await import('../src/lib/server/runner.js');

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM stripe_events`);
  await db.execute(sql`DELETE FROM org_subscriptions`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  createCalls = 0;
}

async function platformId(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  return row.id;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A 'cloud'-runner campaign under an org whose mirrored subscription
 * entered `past_due` `failedDaysAgo` days ago - past GRACE_PERIOD_DAYS
 * is read-only, short of it is still working normally. */
async function seedPastDueCampaign(
  slug: string,
  failedDaysAgo: number,
): Promise<{ orgId: number; projectId: number; campaignId: number }> {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
    .returning();
  const customerId = `cus_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  await db
    .update(schema.organizations)
    .set({ stripeCustomerId: customerId })
    .where(eq(schema.organizations.id, org.id));
  await db.insert(schema.orgSubscriptions).values({
    organizationId: org.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    planId: 'growth',
    status: 'past_due',
    currentPeriodStart: new Date(Date.now() - 20 * DAY_MS),
    currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
    limitRuns: 2000,
    limitSuggestions: 2000,
    limitProjects: 10,
    limitSeats: 3,
    limitDevices: 10,
    limitConcurrency: 4,
    limitBudgetUsd: '30.00',
    limitRetentionDays: 90,
    limitPremiumModels: true,
  });
  const failedEventId = `evt_${randomUUID()}`;
  const failedAt = new Date(Date.now() - failedDaysAgo * DAY_MS);
  await db.insert(schema.stripeEvents).values({
    id: failedEventId,
    type: 'invoice.payment_failed',
    receivedAt: failedAt,
    processedAt: failedAt,
    payload: {
      id: failedEventId,
      type: 'invoice.payment_failed',
      created: Math.floor(failedAt.getTime() / 1000),
      data: { object: { subscription: subscriptionId, customer: customerId } },
    },
  });

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

describe('cloud run dispatch is read-only-gated by a failed payment (#554)', () => {
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

  it('refuses a run once the grace window has elapsed', async () => {
    const { campaignId } = await seedPastDueCampaign(
      'payment-required-over',
      GRACE_PERIOD_DAYS + 1,
    );

    const { runId } = await runCampaign(campaignId);
    const run = await runRow(runId);

    expect(createCalls).toBe(0);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/read-only because of a failed payment/i);
    expect(run?.error).not.toMatch(/plan limit/i);
    expect(run?.failureReason).toBe('plan_payment_required');
  });

  it('admits a run while still inside the grace window', async () => {
    const { campaignId } = await seedPastDueCampaign('payment-required-grace', 3);

    const { runId } = await runCampaign(campaignId);
    const run = await runRow(runId);

    expect(createCalls).toBe(1);
    expect(run?.status).not.toBe('failed');
  });
});
