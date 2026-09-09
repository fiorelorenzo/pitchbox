// #554: the observation collector mirrors /suggest's own read-only gate
// (extension-suggest-payment-required.test.ts), the same way it already
// mirrors /suggest's plan-limit gate (extension-observations-plan-limit.test.ts).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { POST as observationsPost } from '../src/routes/api/extension/observations/+server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function reset() {
  await getDb().execute(sql`TRUNCATE observed_targets, projects RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM assist_usage`);
  await getDb().execute(sql`DELETE FROM stripe_events`);
  await getDb().execute(sql`DELETE FROM org_subscriptions`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM extension_devices`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
}

async function seedPastDueOrgWithProject(slug: string, failedDaysAgo: number) {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'growth', planSource: 'stripe' })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  await saveLinkedInAssistSettings(db, org.id, {
    ...defaultLinkedInAssistSettings(),
    enabled: true,
    collectorEnabled: true,
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

function bearer(token: string | null, body: unknown): Request {
  return new Request('http://x/api/extension/observations', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'urn:li:activity:88881',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:88881/',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    text: 'A post about outreach automation.',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function isHttpError(value: unknown): value is { status: number; body?: { message?: string } } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('status' in value)) return false;
  return typeof value.status === 'number';
}

async function statusAndBodyOf(
  promise: Promise<Response>,
): Promise<{ status: number; message: unknown }> {
  try {
    const res = await promise;
    return { status: res.status, message: await res.json().catch(() => null) };
  } catch (e) {
    if (isHttpError(e)) return { status: e.status, message: e.body?.message };
    throw e;
  }
}

describe('POST /api/extension/observations is read-only-gated by a failed payment (#554)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('refuses with a 403 once the grace window has elapsed', async () => {
    const { org, project } = await seedPastDueOrgWithProject('obs-payment-required-over', 10);
    await mintDevice(org.id, 'tok-obs-payment-over');

    const { status, message } = await statusAndBodyOf(
      observationsPost({
        request: bearer('tok-obs-payment-over', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as unknown as Parameters<typeof observationsPost>[0]),
    );

    expect(status).toBe(403);
    expect(message).toBe('plan_payment_required');
  });

  it('is admitted normally while still inside the grace window', async () => {
    const { org, project } = await seedPastDueOrgWithProject('obs-payment-required-grace', 3);
    await mintDevice(org.id, 'tok-obs-payment-grace');

    const { status } = await statusAndBodyOf(
      observationsPost({
        request: bearer('tok-obs-payment-grace', {
          platform: 'linkedin',
          projectId: project.id,
          items: [observation()],
        }),
      } as unknown as Parameters<typeof observationsPost>[0]),
    );

    expect(status).toBe(200);
  });
});
