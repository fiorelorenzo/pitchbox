// #554: "no new campaigns" for a read-only org. Campaigns carry no metered
// plan-limit ceiling of their own (unlike projects/seats/devices), so this
// is the only plan gate POST /api/campaigns needs.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import type {
  AgentRunHandle,
  AgentRunOptions,
  AgentRunner,
  AgentRunResult,
} from '@pitchbox/shared/agents';
import type { RunnerConfig } from '@pitchbox/shared/agents/config';

const fakeResult: AgentRunResult = { exitCode: 0, logPath: '/dev/null' };

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: (_slug: string, _config: RunnerConfig): AgentRunner => ({
    slug: 'cloud',
    run(_opts: AgentRunOptions): AgentRunHandle {
      return { result: Promise.resolve(fakeResult), cancel: () => {} };
    },
  }),
}));

// Dynamic on purpose - vi.mock above is hoisted, but the campaigns route
// transitively imports runner.js, which has to load after it for
// createAgentRunner to resolve to the fake gateway runner (same pattern as
// gateway-plan-limit-dispatch.test.ts).
const { POST: campaignsPost } = await import('../src/routes/api/campaigns/+server.js');

const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM stripe_events`);
  await db.execute(sql`DELETE FROM org_subscriptions`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedPastDueOrgWithProject(slug: string, failedDaysAgo: number) {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
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
  return { orgId: org.id, projectId: project.id };
}

async function platformId(slug: string): Promise<number> {
  const [platform] = await getDb()
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, slug));
  if (!platform) throw new Error(`platform "${slug}" is not seeded - did global-setup run?`);
  return platform.id;
}

function postEvent(orgId: number, body: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'member' } },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

describe('POST /api/campaigns is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
    process.env.AI_GATEWAY_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
    if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
  });

  it('refuses with plan_payment_required once the grace window has elapsed, creating nothing', async () => {
    const { orgId, projectId } = await seedPastDueOrgWithProject(
      'campaign-payment-required-over',
      10,
    );
    const reddit = await platformId('reddit');

    const res = await campaignsPost(
      postEvent(orgId, {
        projectId,
        platformSlug: 'reddit',
        scenarioSlug: 'reddit-scout',
        name: 'Should not exist',
        objective: 'find leads',
      }),
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('plan_payment_required');

    const rows = await getDb()
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.projectId, projectId));
    expect(rows).toHaveLength(0);
    void reddit; // seeded for the route's own platform lookup, not asserted on
  });

  it('creates the campaign normally while still inside the grace window', async () => {
    const { orgId, projectId } = await seedPastDueOrgWithProject(
      'campaign-payment-required-grace',
      3,
    );

    const res = await campaignsPost(
      postEvent(orgId, {
        projectId,
        platformSlug: 'reddit',
        scenarioSlug: 'reddit-scout',
        name: 'Still fine',
        objective: 'find leads',
      }),
    );

    expect(res.status).toBe(201);
  });
});
