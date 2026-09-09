// checkUsageThresholds (#557): "once per threshold per period" is the whole
// difficulty, so these exercise that directly against hand-built usage
// snapshots (metric()/makeUsage() below) rather than through real
// getOrgUsage() plumbing - usage.test.ts already owns proving getOrgUsage
// itself computes the right used/limit numbers from real runs, projects,
// etc. What matters here is what checkUsageThresholds does with a snapshot
// once it has one.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  checkUsageThresholds,
  USAGE_THRESHOLD_NOTIFICATION_KIND,
} from '../src/usage-notifications.js';
import { saveWebhooks } from '../src/notifications.js';
import type { Entitlements } from '../src/plans.js';
import { getOrgUsage } from '../src/usage.js';
import type { OrgUsageSnapshot, UsageMetric } from '../src/usage.js';
import { calendarPeriodFor, type Period } from '../src/org-quota.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
  await saveWebhooks(db, {});
});

async function makeOrg(): Promise<number> {
  const slug = `usage-notif-test-${randomUUID()}`;
  const [org] = await getDb().insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

function metric(used: number, limit: number | null): UsageMetric {
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

const UNLIMITED: UsageMetric = { used: 0, limit: null, remaining: null };

function makeEntitlements(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    runsPerMonth: null,
    suggestionsPerMonth: null,
    projects: null,
    seats: null,
    extensionDevices: null,
    maxConcurrentRuns: null,
    monthlyRunBudgetUsd: null,
    retentionDays: null,
    premiumModels: true,
    webhooks: true,
    planId: 'free',
    source: 'default',
    graceEndsAt: null,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<OrgUsageSnapshot> = {}): OrgUsageSnapshot {
  return {
    runs: UNLIMITED,
    suggestions: UNLIMITED,
    projects: UNLIMITED,
    accounts: UNLIMITED,
    seats: UNLIMITED,
    extensionDevices: UNLIMITED,
    costUsd: UNLIMITED,
    entitlements: makeEntitlements(),
    ...overrides,
  };
}

const PERIOD_A: Period = {
  start: new Date('2026-01-01T00:00:00Z'),
  end: new Date('2026-02-01T00:00:00Z'),
};
const PERIOD_B: Period = {
  start: new Date('2026-02-01T00:00:00Z'),
  end: new Date('2026-03-01T00:00:00Z'),
};

async function thresholdNotificationsFor(orgId: number) {
  return getDb()
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organizationId, orgId),
        eq(schema.notifications.kind, USAGE_THRESHOLD_NOTIFICATION_KIND),
      ),
    );
}

/** Three call sites below sort/compare notification rows by their
 * payload's threshold - named and cast once here rather than inline at
 * each `.map`/`.every`, since `payload` is untyped jsonb. */
function thresholdOf(row: typeof schema.notifications.$inferSelect): number {
  const payload = row.payload as { threshold: number };
  return payload.threshold;
}

describe('checkUsageThresholds: crossing and repeating', () => {
  it('crossing 80% notifies once, staying over it does not notify again, crossing 100% notifies once more', async () => {
    const orgId = await makeOrg();

    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(80, 100) }), PERIOD_A);
    let rows = await thresholdNotificationsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ metric: 'runs', threshold: 80 });

    // A retry (or five requests racing the same boundary) at the same or a
    // slightly higher usage, still under 100%, must not send a second 80%
    // notification - exactly the burst #557 forbids.
    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(85, 100) }), PERIOD_A);
    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(85, 100) }), PERIOD_A);
    rows = await thresholdNotificationsFor(orgId);
    expect(rows).toHaveLength(1);

    // 100% crosses the second threshold - a distinct notification.
    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(100, 100) }), PERIOD_A);
    rows = await thresholdNotificationsFor(orgId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => thresholdOf(r)).sort((a, b) => a - b)).toEqual([80, 100]);

    // Still at 100%: no third notification for the same threshold.
    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(100, 100) }), PERIOD_A);
    rows = await thresholdNotificationsFor(orgId);
    expect(rows).toHaveLength(2);
  });

  it('a new billing period notifies again for the same metric and threshold', async () => {
    const orgId = await makeOrg();
    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(80, 100) }), PERIOD_A);
    await checkUsageThresholds(getDb(), orgId, makeUsage({ runs: metric(80, 100) }), PERIOD_B);
    const rows = await thresholdNotificationsFor(orgId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => thresholdOf(r) === 80)).toBe(true);
  });

  it('a single jump straight past both thresholds notifies for each of them, not just the higher one', async () => {
    const orgId = await makeOrg();
    // Never seen 80% before - a bulk seat grant can land at 100% in one step.
    await checkUsageThresholds(getDb(), orgId, makeUsage({ seats: metric(10, 10) }), PERIOD_A);
    const rows = await thresholdNotificationsFor(orgId);
    expect(rows.map((r) => thresholdOf(r)).sort((a, b) => a - b)).toEqual([80, 100]);
  });
});

describe('checkUsageThresholds: nothing to cross', () => {
  it('an unlimited axis never notifies, whatever it has used', async () => {
    const orgId = await makeOrg();
    await checkUsageThresholds(
      getDb(),
      orgId,
      makeUsage({ costUsd: metric(1_000_000, null) }),
      PERIOD_A,
    );
    expect(await thresholdNotificationsFor(orgId)).toHaveLength(0);
  });

  it('self-host - every axis already unlimited - never notifies', async () => {
    const orgId = await makeOrg();
    // Mirrors getOrgUsage's real self-host branch: every metric UNLIMITED,
    // entitlements.source 'self-host'. makeUsage()'s defaults already give
    // every axis a null limit, same as that branch.
    const usage = makeUsage({ entitlements: makeEntitlements({ source: 'self-host' }) });
    await checkUsageThresholds(getDb(), orgId, usage, PERIOD_A);
    expect(await thresholdNotificationsFor(orgId)).toHaveLength(0);
  });

  it('a limit of zero never notifies - there is no percentage to compute', async () => {
    const orgId = await makeOrg();
    await checkUsageThresholds(getDb(), orgId, makeUsage({ projects: metric(0, 0) }), PERIOD_A);
    expect(await thresholdNotificationsFor(orgId)).toHaveLength(0);
  });
});

describe('checkUsageThresholds: copy and delivery', () => {
  it('names the axis, the used/limit numbers and the period end - never a bare "near your limit"', async () => {
    const orgId = await makeOrg();
    await checkUsageThresholds(getDb(), orgId, makeUsage({ costUsd: metric(45.5, 50) }), PERIOD_A);
    const [row] = await thresholdNotificationsFor(orgId);
    expect(row.title).toContain('model spend');
    expect(row.title).toContain('80%');
    expect(row.body).toContain('$45.50');
    expect(row.body).toContain('$50.00');
    expect(row.body).toContain('2026-02-01'); // PERIOD_A.end, the day the window rolls
  });

  it('also enqueues a webhook delivery when the instance has one configured', async () => {
    const orgId = await makeOrg();
    await saveWebhooks(getDb(), { url: 'https://hooks.example.com/usage' });
    await checkUsageThresholds(getDb(), orgId, makeUsage({ seats: metric(4, 5) }), PERIOD_A); // 80%
    const deliveries = await getDb()
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.organizationId, orgId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].eventType).toBe(`notification.${USAGE_THRESHOLD_NOTIFICATION_KIND}`);
    expect(deliveries[0].status).toBe('pending');
  });

  it('enqueues no webhook delivery when the instance has none configured', async () => {
    const orgId = await makeOrg();
    await checkUsageThresholds(getDb(), orgId, makeUsage({ seats: metric(4, 5) }), PERIOD_A);
    const deliveries = await getDb()
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.organizationId, orgId));
    expect(deliveries).toHaveLength(0);
  });
});

describe('checkUsageThresholds: integration with a real getOrgUsage snapshot', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('notifies off the real snapshot getOrgUsage computes, not just a hand-built one - proves the wiring, not just the fixture', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const db = getDb();
    const slug = `usage-notif-integration-${randomUUID()}`;
    const [org] = await db
      .insert(schema.organizations)
      .values({ slug, name: slug, plan: 'free' })
      .returning();
    createdOrgIds.push(org.id);
    // The free plan's own project ceiling is 1 (shared/src/plans.ts's
    // PLAN_CATALOGUE.free.projects) - one real project already lands the
    // org exactly at 100%, no usage fixture required.
    await db.insert(schema.projects).values({ organizationId: org.id, slug: 'p', name: 'p' });

    const period = calendarPeriodFor(org.createdAt, new Date());
    const usage = await getOrgUsage(db, org.id, period);
    await checkUsageThresholds(db, org.id, usage, period);

    const rows = await thresholdNotificationsFor(org.id);
    expect(rows.map((r) => thresholdOf(r)).sort((a, b) => a - b)).toEqual([80, 100]);
    const metrics = rows.map((r) => {
      const payload = r.payload as { metric: string };
      return payload.metric;
    });
    expect(metrics.every((m) => m === 'projects')).toBe(true);
  });
});
