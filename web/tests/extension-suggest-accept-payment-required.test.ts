// #554: "no accepts" is one of the explicit refusals a read-only org gets -
// a suggestion nobody can request cannot legitimately be committed to a
// draft either. Mirrors extension-suggest-payment-required.test.ts's org
// seeding, exercised against the accept route instead.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GRACE_PERIOD_DAYS } from '@pitchbox/shared/billing/grace';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { POST as accept } from '../src/routes/api/extension/suggest/accept/+server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, contact_history, blocklist, extension_devices RESTART IDENTITY CASCADE`,
  );
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

async function seedPastDueOrgProject(slug: string, failedDaysAgo: number) {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug, description: `about ${slug}` })
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
  await getDb()
    .insert(schema.extensionDevices)
    .values({
      organizationId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      label: 'test',
    });
}

function request(token: string | null, body: unknown) {
  return new Request('http://x/api/extension/suggest/accept', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000001',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  },
  body: 'We hit the same wall and cut p99 in half by batching the writes.',
};

describe('POST /api/extension/suggest/accept is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('refuses with plan_payment_required once the grace window has elapsed, and files no draft', async () => {
    const { org, project } = await seedPastDueOrgProject(
      'payment-required-accept-over',
      GRACE_PERIOD_DAYS + 1,
    );
    await mintDevice(org.id, 'tok-accept-over');

    const res = await accept({
      request: request('tok-accept-over', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { refused?: string };
    expect(body.refused).toBe('plan_payment_required');

    const drafts = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.projectId, project.id));
    expect(drafts).toHaveLength(0);
  });

  it('is not refused for payment while still inside the grace window', async () => {
    const { org, project } = await seedPastDueOrgProject('payment-required-accept-grace', 3);
    await mintDevice(org.id, 'tok-accept-grace');

    const res = await accept({
      request: request('tok-accept-grace', { ...POST_BODY, projectId: project.id }),
    } as never);

    expect(res.status).toBe(200);
    // Still inside grace: whatever this accept resolves to (a real draft or
    // some other domain refusal such as a missing account), it must not be
    // the payment gate - that is the one behavior #554 adds to this route.
    const body = (await res.json()) as { refused?: string };
    expect(body.refused).not.toBe('plan_payment_required');
  });
});
