import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { DRAFT_MARKER } from '@pitchbox/shared/assist/envelope';

/**
 * #554: the assist plane's own read-only gate. `POST /api/extension/suggest`
 * refuses with a renderable `200 {refused: 'plan_payment_required'}` once an
 * org's grace window has elapsed - distinct from `plan_limit_reached`
 * (extension-suggest-plan-limit.test.ts), since the fix is the customer
 * portal, not waiting or upgrading.
 *
 * In its own module for a fresh in-memory rate-limiter budget, the same
 * reason every other suggest-route test in this repo is.
 */

const REASONING = 'Noticed the cache change and the specific number.';
const DRAFT = 'A specific thing that happened.';
const ENVELOPE_CHUNKS = [`${REASONING}\n`, DRAFT_MARKER, '\n', DRAFT];

vi.mock('@pitchbox/shared/agents/registry', () => ({
  createAgentRunner: () => ({
    slug: 'fake',
    run(opts: { onTextChunk?: (c: string) => void }) {
      for (const c of ENVELOPE_CHUNKS) opts.onTextChunk?.(c);
      return {
        result: Promise.resolve({
          exitCode: 0,
          logPath: '/dev/null',
          usage: {
            inputTokens: 2,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.004,
            costReported: true,
          },
        }),
        cancel: () => {},
      };
    },
  }),
}));

// Dynamic on purpose - vi.mock above is hoisted, but the route module has to
// load after it for createAgentRunner to resolve to the fake agent (same
// pattern as every other suggest-route test in this repo).
const { POST: suggest } = await import('../src/routes/api/extension/suggest/+server.js');

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, contact_history, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM assist_usage`);
  await getDb().execute(sql`DELETE FROM stripe_events`);
  await getDb().execute(sql`DELETE FROM org_subscriptions`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // LOR-318: the instance-wide `default_runner` row is written by seven
  // other files and cleared by none, and under cloud edition a leaked
  // `claude-code` pin makes this file's route refuse to dispatch. Nothing
  // here wants an operator pin, so clear it rather than inherit one.
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'default_runner'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
}

/** An org+project with the assist switch on, whose mirrored subscription
 * entered `past_due` `failedDaysAgo` days ago. */
async function seedPastDueOrgProject(slug: string, failedDaysAgo: number) {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `p-${slug}`,
      name: slug,
      description: `about ${slug}`,
      defaultAgentRunner: 'cloud',
    })
    .returning();
  await saveLinkedInAssistSettings(db, org.id, {
    ...defaultLinkedInAssistSettings(),
    enabled: true,
    projectId: project.id,
  });

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
  return { org, project };
}

async function mintDevice(organizationId: number | null, token: string) {
  const [device] = await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' })
    .returning();
  return device;
}

function request(token: string | null, body: unknown) {
  return new Request('http://x/api/extension/suggest', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000099',
    authorName: 'Giulia Bianchi',
    text: 'We cut p99 in half.',
  },
};

describe('POST /api/extension/suggest is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('refuses with plan_payment_required once the grace window has elapsed', async () => {
    const { org, project } = await seedPastDueOrgProject(
      'payment-required-suggest-over',
      GRACE_PERIOD_DAYS + 1,
    );
    await mintDevice(org.id, 'tok-payment-required-over');

    const res = await suggest({
      request: request('tok-payment-required-over', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { refused?: string; upgradeUrl?: string };
    expect(body.refused).toBe('plan_payment_required');
    // No ledger row from a refused request - nothing was produced to bill.
    const rows = await getDb()
      .select()
      .from(schema.assistUsage)
      .where(eq(schema.assistUsage.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it('proceeds normally while still inside the grace window', async () => {
    const { org, project } = await seedPastDueOrgProject('payment-required-suggest-grace', 3);
    await mintDevice(org.id, 'tok-payment-required-grace');

    const res = await suggest({
      request: request('tok-payment-required-grace', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).not.toContain('plan_payment_required');
  });
});
