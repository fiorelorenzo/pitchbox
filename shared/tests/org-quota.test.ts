// Exercises shared/src/org-quota.ts: an org's billing-period spend sum and
// the quota snapshot the dispatch pre-flight reads
// (web/src/lib/server/runner.ts) before every cloud-runner run. #545: the
// spend window used to be the UTC calendar month unconditionally
// (`startOfMonthUtc`); it is now the org's billing period
// (`billingPeriodFor`) - a live subscription's own Stripe period, or a
// calendar month anchored on the org's own `createdAt` day-of-month for an
// org with no subscription (free or self-host). Each test creates its own
// organization + project (unique slug) rather than reusing the seeded
// 'default' org, and cleans up via cascade delete on the org - this DB is
// shared across test files and teardown intentionally leaves data for
// inspection.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../src/db/client.js';
import {
  assertOrgConcurrencyAdmitted,
  billingPeriodFor,
  calendarPeriodFor,
  getOrgPeriodCostUsd,
  getOrgPeriodSpend,
  getOrgQuotaFields,
  getOrgQuotaSnapshot,
  resolveBillingPeriod,
  setOrgQuota,
  startOfMonthUtc,
  type Period,
} from '../src/org-quota.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    // Cascades to projects -> runs (organizations -> projects -> runs are all
    // onDelete: 'cascade' in schema.ts).
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

// An anchor on the 1st of a month far in the past reproduces the exact
// "plain calendar month" window every test below expects
// (calendarPeriodFor's day-of-month clamping only bites for anchors after
// the 1st) - most of these tests are about the underlying SUM query, not
// about #545's anchoring behavior itself, which gets its own describe
// blocks further down.
const CALENDAR_ANCHOR = new Date('2020-01-01T00:00:00Z');
function monthPeriod(now: Date): Period {
  return calendarPeriodFor(CALENDAR_ANCHOR, now);
}

async function setupOrg(
  opts: {
    monthlyRunBudgetUsd?: string | null;
    maxConcurrentRuns?: number | null;
    createdAt?: Date;
  } = {},
) {
  const db = getDb();
  const slug = `org-quota-test-${randomUUID()}`;
  const [org] = await db
    .insert(schema.organizations)
    .values({
      slug,
      name: slug,
      monthlyRunBudgetUsd: opts.monthlyRunBudgetUsd ?? null,
      maxConcurrentRuns: opts.maxConcurrentRuns ?? null,
      createdAt: opts.createdAt ?? CALENDAR_ANCHOR,
    })
    .returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'p' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

async function makeRun(opts: { projectId: number; costUsd: string | null; startedAt: Date }) {
  const db = getDb();
  // kind: 'project_extraction' is one of the project_id-targeted run kinds
  // the runs_kind_target_chk CHECK constraint accepts without also requiring
  // a campaign_id (unlike the 'campaign' default kind) - the simplest way to
  // insert a run against a bare project fixture with no campaign.
  await db.insert(schema.runs).values({
    kind: 'project_extraction',
    projectId: opts.projectId,
    trigger: 'manual',
    status: 'success',
    costUsd: opts.costUsd,
    startedAt: opts.startedAt,
  });
}
/** A `kind: 'assist'` run - what accepting a suggestion writes
 * (shared/src/assist-accept.ts) to hang the resulting draft's `run_id` off.
 * `costUsd` defaults to null (#522: the accept path never sets it anymore),
 * but can be overridden to prove the org total ignores it regardless. */
async function makeAssistRun(opts: {
  projectId: number;
  costUsd?: string | null;
  startedAt: Date;
}) {
  const db = getDb();
  await db.insert(schema.runs).values({
    kind: 'assist',
    projectId: opts.projectId,
    trigger: 'manual',
    status: 'success',
    costUsd: opts.costUsd ?? null,
    startedAt: opts.startedAt,
  });
}

/** One row of the #522 assist-usage ledger: what `/api/extension/suggest`
 * writes for every suggestion, streamed and accepted or not, the moment its
 * stream finishes. */
async function makeAssistUsage(opts: {
  organizationId: number | null;
  projectId: number;
  costUsd: string | null;
  createdAt: Date;
}) {
  const db = getDb();
  const [platform] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  await db.insert(schema.assistUsage).values({
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    deviceId: null,
    platformId: platform.id,
    kind: 'post_comment',
    agentRunner: 'claude-code',
    costUsd: opts.costUsd,
    createdAt: opts.createdAt,
  });
}

/** A `running` run under a bare project, for the concurrency-admission
 * tests below - `assertOrgConcurrencyAdmitted` ranks exactly this status,
 * unlike `makeRun` above which seeds `success` rows for the cost sum. */
async function makeRunningRun(projectId: number): Promise<number> {
  const db = getDb();
  const [run] = await db
    .insert(schema.runs)
    .values({ kind: 'project_extraction', projectId, trigger: 'manual', status: 'running' })
    .returning({ id: schema.runs.id });
  return run.id;
}

/** A second project in the same org, so a campaign can be anchored to a
 * DIFFERENT project than the one a run's own `projectId` points at - the
 * scenario that exposes the double-count bug in the old
 * `innerJoin(projects, or(...))` query shape. */
async function setupOrgWithTwoProjects() {
  const db = getDb();
  const slug = `org-quota-test-${randomUUID()}`;
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, createdAt: CALENDAR_ANCHOR })
    .returning();
  createdOrgIds.push(org.id);
  const [projectA] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'pa', name: 'pa' })
    .returning();
  const [projectB] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'pb', name: 'pb' })
    .returning();
  return { orgId: org.id, projectAId: projectA.id, projectBId: projectB.id };
}

async function makeCampaign(projectId: number): Promise<number> {
  const db = getDb();
  const [platform] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  return campaign.id;
}

/** A `kind: 'campaign'` run, anchored to a campaign rather than a bare
 * project. `projectId` is optional - a campaign run's own `runs.projectId` is
 * normally null (the campaign carries the project transitively), but can
 * also be set (a "dual-key" row) to exercise the double-count scenario. */
async function makeCampaignRun(opts: {
  campaignId: number;
  projectId?: number | null;
  costUsd: string | null;
  startedAt: Date;
}) {
  const db = getDb();
  await db.insert(schema.runs).values({
    kind: 'campaign',
    campaignId: opts.campaignId,
    projectId: opts.projectId ?? null,
    trigger: 'manual',
    status: 'success',
    costUsd: opts.costUsd,
    startedAt: opts.startedAt,
  });
}

describe('startOfMonthUtc', () => {
  it('returns the first instant of the calendar month in UTC', () => {
    expect(startOfMonthUtc(new Date('2026-07-15T23:59:59Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(startOfMonthUtc(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('calendarPeriodFor', () => {
  it('anchors the period on the day-of-month of `anchor`, not the 1st (#545)', () => {
    const anchor = new Date('2026-01-20T00:00:00Z');
    const p = calendarPeriodFor(anchor, new Date('2026-09-09T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('flips to the next period exactly at the anchor day, not before or after', () => {
    const anchor = new Date('2026-01-20T00:00:00Z');
    const justBefore = calendarPeriodFor(anchor, new Date('2026-09-19T23:59:59.999Z'));
    expect(justBefore.end.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    const atBoundary = calendarPeriodFor(anchor, new Date('2026-09-20T00:00:00Z'));
    expect(atBoundary.start.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(atBoundary.end.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('clamps a month-end anchor to the target month real length rather than overflowing', () => {
    // Anchored on the 31st: February (28 days in 2026) can't hold a 31st, so
    // that period is short, and the following one starts on Feb 28 - a
    // billing period is bounded by real calendar days, not a fixed count.
    const anchor = new Date('2026-01-31T00:00:00Z');
    const inFeb = calendarPeriodFor(anchor, new Date('2026-02-15T00:00:00Z'));
    expect(inFeb.start.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(inFeb.end.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    const inLateFeb = calendarPeriodFor(anchor, new Date('2026-02-28T12:00:00Z'));
    expect(inLateFeb.start.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(inLateFeb.end.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('preserves the anchor time-of-day, not just the date', () => {
    const anchor = new Date('2026-01-20T15:30:00Z');
    const p = calendarPeriodFor(anchor, new Date('2026-09-09T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-08-20T15:30:00.000Z');
  });
});

describe('resolveBillingPeriod', () => {
  it('a live subscription period always wins over the calendar fallback', () => {
    const subscriptionPeriod: Period = {
      start: new Date('2026-01-20T00:00:00Z'),
      end: new Date('2026-02-20T00:00:00Z'),
    };
    const p = resolveBillingPeriod(
      { orgCreatedAt: new Date('2026-01-01T00:00:00Z'), subscriptionPeriod },
      new Date('2026-01-25T00:00:00Z'),
    );
    expect(p).toEqual(subscriptionPeriod);
  });

  it('falls back to the creation-anchored calendar month with no subscription', () => {
    const p = resolveBillingPeriod(
      { orgCreatedAt: new Date('2026-01-20T00:00:00Z'), subscriptionPeriod: null },
      new Date('2026-09-09T00:00:00Z'),
    );
    expect(p.start.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  // #545 acceptance: a free org's window is stable and does not shift when
  // it subscribes, or after its subscription lapses - it is always derived
  // from `organizations.createdAt`, never from Stripe. Losing the
  // subscription (subscriptionPeriod: null again) falls back to the exact
  // same calendar anchor it always had, not a window that shifted to
  // whenever the subscription happened to end.
  it('a lapsed subscription falls back to the SAME calendar anchor the org always had', () => {
    const orgCreatedAt = new Date('2026-01-20T00:00:00Z');
    const now = new Date('2026-09-09T00:00:00Z');
    const neverSubscribed = resolveBillingPeriod({ orgCreatedAt, subscriptionPeriod: null }, now);
    const lapsed = resolveBillingPeriod({ orgCreatedAt, subscriptionPeriod: null }, now);
    expect(lapsed).toEqual(neverSubscribed);
    expect(lapsed.start.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });
});

describe('getOrgPeriodCostUsd', () => {
  it('sums only this org runs started within the period', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    const thisMonthEarly = new Date('2026-07-01T00:00:00Z');
    const thisMonthLate = new Date('2026-07-14T00:00:00Z');
    const lastMonth = new Date('2026-06-30T23:59:59Z');

    await makeRun({ projectId, costUsd: '1.5000', startedAt: thisMonthEarly });
    await makeRun({ projectId, costUsd: '2.2500', startedAt: thisMonthLate });
    await makeRun({ projectId, costUsd: '99.0000', startedAt: lastMonth });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(3.75, 4);
  });

  it('treats a null cost_usd (no usage reported) as 0', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId, costUsd: null, startedAt: new Date('2026-07-02T00:00:00Z') });
    await makeRun({ projectId, costUsd: '4.0000', startedAt: new Date('2026-07-03T00:00:00Z') });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(4.0, 4);
  });

  it('returns 0 for an org with no runs at all', async () => {
    const { orgId } = await setupOrg();
    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(new Date('2026-07-15T12:00:00Z')));
    expect(total).toBe(0);
  });

  it('never counts a different org run, even started the same period', async () => {
    const orgA = await setupOrg();
    const orgB = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId: orgA.projectId, costUsd: '10.0000', startedAt: now });
    await makeRun({ projectId: orgB.projectId, costUsd: '20.0000', startedAt: now });

    expect(await getOrgPeriodCostUsd(getDb(), orgA.orgId, monthPeriod(now))).toBeCloseTo(10, 4);
    expect(await getOrgPeriodCostUsd(getDb(), orgB.orgId, monthPeriod(now))).toBeCloseTo(20, 4);
  });

  // Regression coverage for the double-count bug the old
  // `innerJoin(projects, or(eq(projects.id, runs.projectId), eq(projects.id,
  // campaigns.projectId)))` shape had: that join can match TWO project rows
  // for one run whenever runs.projectId and campaigns.projectId differ,
  // doubling the run's cost in the un-grouped SUM.
  it('counts a campaign-anchored run (runs.projectId null) exactly once', async () => {
    const { orgId, projectId } = await setupOrg();
    const campaignId = await makeCampaign(projectId);
    const now = new Date('2026-07-15T12:00:00Z');
    await makeCampaignRun({ campaignId, projectId: null, costUsd: '5.0000', startedAt: now });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(5.0, 4);
  });

  it('counts a dual-key run (runs.projectId and campaigns.projectId set to DIFFERENT org projects) exactly once, not doubled', async () => {
    const { orgId, projectAId, projectBId } = await setupOrgWithTwoProjects();
    // The campaign is anchored to project B, but the run's own projectId
    // points at project A - both belong to the same org, so the old
    // OR-innerJoin against `projects` matched both rows for this one run.
    const campaignId = await makeCampaign(projectBId);
    const now = new Date('2026-07-15T12:00:00Z');
    await makeCampaignRun({
      campaignId,
      projectId: projectAId,
      costUsd: '7.0000',
      startedAt: now,
    });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(7.0, 4);
  });

  it('keeps cross-org isolation with campaign-anchored runs', async () => {
    const orgA = await setupOrg();
    const orgB = await setupOrg();
    const campaignA = await makeCampaign(orgA.projectId);
    const campaignB = await makeCampaign(orgB.projectId);
    const now = new Date('2026-07-15T12:00:00Z');
    await makeCampaignRun({
      campaignId: campaignA,
      projectId: null,
      costUsd: '10.0000',
      startedAt: now,
    });
    await makeCampaignRun({
      campaignId: campaignB,
      projectId: null,
      costUsd: '20.0000',
      startedAt: now,
    });

    expect(await getOrgPeriodCostUsd(getDb(), orgA.orgId, monthPeriod(now))).toBeCloseTo(10, 4);
    expect(await getOrgPeriodCostUsd(getDb(), orgB.orgId, monthPeriod(now))).toBeCloseTo(20, 4);
  });

  // #545: a run started before the period's start (e.g. under a previous
  // billing period, or before a mid-cycle upgrade) must never leak into the
  // new period's sum - the old calendar-month code had no upper bound at
  // all, which happened to be safe only because nothing sums a period other
  // than "now"'s own; a genuine period with a real end now needs the check.
  it('excludes a run started on or after the period end', async () => {
    const { orgId, projectId } = await setupOrg();
    const period: Period = {
      start: new Date('2026-01-20T00:00:00Z'),
      end: new Date('2026-02-20T00:00:00Z'),
    };
    await makeRun({ projectId, costUsd: '5.0000', startedAt: new Date('2026-02-19T23:59:59Z') });
    await makeRun({ projectId, costUsd: '99.0000', startedAt: new Date('2026-02-20T00:00:00Z') });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, period);
    expect(total).toBeCloseTo(5.0, 4);
  });
});

// #522: the org total must see the LinkedIn assistant's spend too, not only
// campaign/project runs - see the doc comment on getOrgPeriodSpend for why
// assist_usage exists as a separate ledger.
describe('getOrgPeriodCostUsd: assistant usage (#522)', () => {
  it('a suggestion that was streamed and never accepted still counts toward the org total', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    // No runs row at all - exactly what /api/extension/suggest leaves behind
    // for a suggestion nobody accepted.
    await makeAssistUsage({
      organizationId: orgId,
      projectId,
      costUsd: '0.0090',
      createdAt: now,
    });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(0.009, 4);
  });

  it('adds assistant spend on top of campaign spend rather than replacing it', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId, costUsd: '5.0000', startedAt: now });
    await makeAssistUsage({ organizationId: orgId, projectId, costUsd: '0.5000', createdAt: now });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(5.5, 4);
  });

  it('twenty suggestions with two accepted are counted twenty times, not twice', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    // Every suggestion ledgers its own cost the moment its stream finishes,
    // whether or not a human ever accepts it.
    for (let i = 0; i < 20; i += 1) {
      await makeAssistUsage({
        organizationId: orgId,
        projectId,
        costUsd: '0.0100',
        createdAt: now,
      });
    }
    // Two of those twenty were accepted - shared/src/assist-accept.ts writes
    // a `runs` row (kind: 'assist') to hang the resulting draft off, but
    // never sets that row's own cost_usd (#522).
    await makeAssistRun({ projectId, startedAt: now });
    await makeAssistRun({ projectId, startedAt: now });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(0.2, 4);
  });

  it('ignores an assist run even if its own cost_usd were somehow set, so accepting never double-counts', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeAssistUsage({ organizationId: orgId, projectId, costUsd: '0.0090', createdAt: now });
    // A defensive scenario: an assist run whose cost_usd was set to the same
    // figure the assist_usage row already carries. If getOrgPeriodCostUsd
    // summed kind='assist' runs too, this suggestion would count twice.
    await makeAssistRun({ projectId, costUsd: '0.0090', startedAt: now });

    const total = await getOrgPeriodCostUsd(getDb(), orgId, monthPeriod(now));
    expect(total).toBeCloseTo(0.009, 4);
  });

  it('never counts a different org assist usage row', async () => {
    const orgA = await setupOrg();
    const orgB = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeAssistUsage({
      organizationId: orgA.orgId,
      projectId: orgA.projectId,
      costUsd: '1.0000',
      createdAt: now,
    });
    await makeAssistUsage({
      organizationId: orgB.orgId,
      projectId: orgB.projectId,
      costUsd: '2.0000',
      createdAt: now,
    });

    expect(await getOrgPeriodCostUsd(getDb(), orgA.orgId, monthPeriod(now))).toBeCloseTo(1, 4);
    expect(await getOrgPeriodCostUsd(getDb(), orgB.orgId, monthPeriod(now))).toBeCloseTo(2, 4);
  });
});

describe('getOrgPeriodSpend', () => {
  it('keeps campaign and assistant spend apart, and sums them into a total', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId, costUsd: '5.0000', startedAt: now });
    await makeAssistUsage({ organizationId: orgId, projectId, costUsd: '1.2500', createdAt: now });

    const spend = await getOrgPeriodSpend(getDb(), orgId, monthPeriod(now));
    expect(spend.campaignUsd).toBeCloseTo(5, 4);
    expect(spend.assistantUsd).toBeCloseTo(1.25, 4);
    expect(spend.totalUsd).toBeCloseTo(6.25, 4);
  });

  it('only counts assist usage from within the period', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeAssistUsage({
      organizationId: orgId,
      projectId,
      costUsd: '9.0000',
      createdAt: new Date('2026-06-30T23:59:59Z'),
    });
    await makeAssistUsage({
      organizationId: orgId,
      projectId,
      costUsd: '0.5000',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    });

    const spend = await getOrgPeriodSpend(getDb(), orgId, monthPeriod(now));
    expect(spend.assistantUsd).toBeCloseTo(0.5, 4);
  });
});

describe('billingPeriodFor', () => {
  it('an org with no subscription gets the creation-anchored calendar month', async () => {
    const { orgId } = await setupOrg({ createdAt: new Date('2026-01-20T00:00:00Z') });
    const period = await billingPeriodFor(getDb(), orgId, new Date('2026-09-09T00:00:00Z'));
    expect(period.start.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('an org with a live subscription gets exactly its stored Stripe period, regardless of createdAt', async () => {
    const { orgId } = await setupOrg({ createdAt: new Date('2026-01-01T00:00:00Z') });
    const db = getDb();
    const [platform] = await db
      .select({ id: schema.platforms.id })
      .from(schema.platforms)
      .limit(1);
    await db.insert(schema.orgSubscriptions).values({
      organizationId: orgId,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: `sub_test_${randomUUID()}`,
      planId: 'solo',
      status: 'active',
      currentPeriodStart: new Date('2026-01-20T00:00:00Z'),
      currentPeriodEnd: new Date('2026-02-20T00:00:00Z'),
      limitPremiumModels: false,
    });
    void platform;

    const period = await billingPeriodFor(getDb(), orgId, new Date('2026-01-25T00:00:00Z'));
    expect(period.start.toISOString()).toBe('2026-01-20T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-02-20T00:00:00.000Z');
  });
});

// #545 acceptance: an org with a subscription starting on the 20th has its
// allowance reset on the 20th, and spend from BEFORE the subscription
// (under the old free-plan calendar window) stays in the old period rather
// than counting against the new one.
describe('#545 acceptance: subscribing mid-cycle resets the spend window', () => {
  it('spend before a mid-cycle subscription never counts toward the new period', async () => {
    const { orgId, projectId } = await setupOrg({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      monthlyRunBudgetUsd: '10.00',
    });
    // Free-plan spend on the 15th, under the org's original calendar-month
    // window (anchored on Jan 1st).
    await makeRun({ projectId, costUsd: '8.00', startedAt: new Date('2026-01-15T00:00:00Z') });

    const db = getDb();
    await db.insert(schema.orgSubscriptions).values({
      organizationId: orgId,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: `sub_test_${randomUUID()}`,
      planId: 'solo',
      status: 'active',
      currentPeriodStart: new Date('2026-01-20T00:00:00Z'),
      currentPeriodEnd: new Date('2026-02-20T00:00:00Z'),
      limitPremiumModels: false,
    });

    // A run under the new subscription period, well within its own $10 budget.
    await makeRun({ projectId, costUsd: '2.00', startedAt: new Date('2026-01-25T00:00:00Z') });

    const snapshot = await getOrgQuotaSnapshot(getDb(), orgId, new Date('2026-01-25T00:00:00Z'));
    // If the pre-subscription $8 leaked into the new period, remaining would
    // be 0 (10 - 8 - 2); it must instead reflect only the post-subscription run.
    expect(snapshot.remainingUsd).toBeCloseTo(8, 4);
  });

  it("resets the allowance again once the org's period rolls over on the 20th", async () => {
    const { orgId, projectId } = await setupOrg({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      monthlyRunBudgetUsd: '10.00',
    });
    const db = getDb();
    await db.insert(schema.orgSubscriptions).values({
      organizationId: orgId,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: `sub_test_${randomUUID()}`,
      planId: 'solo',
      status: 'active',
      currentPeriodStart: new Date('2026-01-20T00:00:00Z'),
      currentPeriodEnd: new Date('2026-02-20T00:00:00Z'),
      limitPremiumModels: false,
    });
    await makeRun({ projectId, costUsd: '9.00', startedAt: new Date('2026-01-25T00:00:00Z') });

    // Still inside the same Stripe period the row above just spent $9 of the
    // $10 budget: 1 remaining.
    const stillInPeriod = await getOrgQuotaSnapshot(
      getDb(),
      orgId,
      new Date('2026-02-19T00:00:00Z'),
    );
    expect(stillInPeriod.remainingUsd).toBeCloseTo(1, 4);

    // Stripe rolls `current_period_start`/`end` forward when the webhook
    // fires (#551, out of scope here) - simulate that write directly.
    await db
      .update(schema.orgSubscriptions)
      .set({
        currentPeriodStart: new Date('2026-02-20T00:00:00Z'),
        currentPeriodEnd: new Date('2026-03-20T00:00:00Z'),
      })
      .where(eq(schema.orgSubscriptions.organizationId, orgId));

    const nextPeriod = await getOrgQuotaSnapshot(getDb(), orgId, new Date('2026-02-21T00:00:00Z'));
    expect(nextPeriod.remainingUsd).toBeCloseTo(10, 4);
  });
});

describe('getOrgQuotaSnapshot', () => {
  it('computes remainingUsd as budget minus period-to-date spend when a budget is set', async () => {
    const { orgId, projectId } = await setupOrg({ monthlyRunBudgetUsd: '100.00' });
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId, costUsd: '37.50', startedAt: now });

    const snapshot = await getOrgQuotaSnapshot(getDb(), orgId, now);
    expect(snapshot.remainingUsd).toBeCloseTo(62.5, 4);
  });

  it('a remainingUsd can go negative once spend exceeds the budget (the caller decides admission)', async () => {
    const { orgId, projectId } = await setupOrg({ monthlyRunBudgetUsd: '10.00' });
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId, costUsd: '15.00', startedAt: now });

    const snapshot = await getOrgQuotaSnapshot(getDb(), orgId, now);
    expect(snapshot.remainingUsd).toBeCloseTo(-5.0, 4);
  });

  // #522 acceptance: the existing per-org budget check
  // (web/src/lib/server/runner.ts reads getOrgQuotaSnapshot before every
  // cloud-runner dispatch) has to be able to refuse a run on assistant
  // spend alone, with zero campaign runs ever having happened.
  it('goes over budget from assistant usage alone, with no campaign runs at all', async () => {
    const { orgId, projectId } = await setupOrg({ monthlyRunBudgetUsd: '5.00' });
    const now = new Date('2026-07-15T12:00:00Z');
    for (let i = 0; i < 10; i += 1) {
      await makeAssistUsage({
        organizationId: orgId,
        projectId,
        costUsd: '0.6000',
        createdAt: now,
      });
    }

    const snapshot = await getOrgQuotaSnapshot(getDb(), orgId, now);
    expect(snapshot.remainingUsd).toBeCloseTo(-1.0, 4);
    expect(snapshot.remainingUsd).not.toBeNull();
    expect(snapshot.remainingUsd!).toBeLessThanOrEqual(0);
  });

  it('returns remainingUsd: null (unlimited) when the org has no configured budget', async () => {
    const { orgId, projectId } = await setupOrg({ monthlyRunBudgetUsd: null });
    await makeRun({ projectId, costUsd: '9999.0000', startedAt: new Date('2026-07-15T12:00:00Z') });

    const snapshot = await getOrgQuotaSnapshot(getDb(), orgId, new Date('2026-07-15T12:00:00Z'));
    expect(snapshot.remainingUsd).toBeNull();
  });

  it('carries the org concurrencyCap through, or null when unset', async () => {
    const capped = await setupOrg({ maxConcurrentRuns: 3 });
    const uncapped = await setupOrg({ maxConcurrentRuns: null });

    expect((await getOrgQuotaSnapshot(getDb(), capped.orgId)).concurrencyCap).toBe(3);
    expect((await getOrgQuotaSnapshot(getDb(), uncapped.orgId)).concurrencyCap).toBeNull();
  });

  it('returns fully unlimited for an org id that does not exist', async () => {
    const snapshot = await getOrgQuotaSnapshot(getDb(), -1);
    expect(snapshot).toEqual({ remainingUsd: null, concurrencyCap: null });
  });
});

// getOrgQuotaFields / setOrgQuota back the org-quota settings UI (#161): an
// operator sets `organizations.monthly_run_budget_usd` and
// `max_concurrent_runs` from the dashboard instead of raw SQL. These are
// plain read/write helpers over the two columns - the numeric column comes
// back from Postgres as a string, so getOrgQuotaFields normalizes it to a
// number (or null) the same way getOrgQuotaSnapshot already does.
describe('getOrgQuotaFields', () => {
  it('returns the current budget + cap for an org', async () => {
    const { orgId } = await setupOrg({ monthlyRunBudgetUsd: '25.50', maxConcurrentRuns: 4 });
    expect(await getOrgQuotaFields(getDb(), orgId)).toEqual({
      monthlyRunBudgetUsd: 25.5,
      maxConcurrentRuns: 4,
    });
  });

  it('returns both fields null (unlimited) when unset', async () => {
    const { orgId } = await setupOrg();
    expect(await getOrgQuotaFields(getDb(), orgId)).toEqual({
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
  });

  it('returns null for an org id that does not exist', async () => {
    expect(await getOrgQuotaFields(getDb(), -1)).toBeNull();
  });
});

describe('setOrgQuota', () => {
  it('persists a budget + cap, round-tripping through getOrgQuotaFields', async () => {
    const { orgId } = await setupOrg();
    const ok = await setOrgQuota(getDb(), orgId, {
      monthlyRunBudgetUsd: 42.5,
      maxConcurrentRuns: 5,
    });
    expect(ok).toBe(true);
    expect(await getOrgQuotaFields(getDb(), orgId)).toEqual({
      monthlyRunBudgetUsd: 42.5,
      maxConcurrentRuns: 5,
    });
  });

  it('clears both fields back to unlimited (null)', async () => {
    const { orgId } = await setupOrg({ monthlyRunBudgetUsd: '10.00', maxConcurrentRuns: 2 });
    const ok = await setOrgQuota(getDb(), orgId, {
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
    expect(ok).toBe(true);
    expect(await getOrgQuotaFields(getDb(), orgId)).toEqual({
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
  });

  it('never touches a different org row', async () => {
    const a = await setupOrg({ monthlyRunBudgetUsd: '10.00', maxConcurrentRuns: 1 });
    const b = await setupOrg({ monthlyRunBudgetUsd: '20.00', maxConcurrentRuns: 2 });
    await setOrgQuota(getDb(), a.orgId, { monthlyRunBudgetUsd: 99, maxConcurrentRuns: 9 });
    expect(await getOrgQuotaFields(getDb(), b.orgId)).toEqual({
      monthlyRunBudgetUsd: 20,
      maxConcurrentRuns: 2,
    });
  });

  it('returns false for an org id that does not exist', async () => {
    const ok = await setOrgQuota(getDb(), -1, { monthlyRunBudgetUsd: 1, maxConcurrentRuns: 1 });
    expect(ok).toBe(false);
  });
});

// #485: organizations.max_concurrent_runs went unenforced once the old
// runner service's in-memory per-org session map disappeared with it
// (#420). assertOrgConcurrencyAdmitted is the replacement - see its own
// doc comment in ../src/org-quota.ts for why it ranks live `running` rows
// under an org-scoped pg_advisory_xact_lock rather than a maintained
// counter or a plain count-then-decide read.
describe('assertOrgConcurrencyAdmitted', () => {
  it('admits a run when the org is under its concurrency cap', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: 2 });
    await makeRunningRun(projectId); // one other run already occupying a slot
    const runId = await makeRunningRun(projectId);

    await expect(assertOrgConcurrencyAdmitted(getDb(), orgId, runId)).resolves.toBeUndefined();
  });

  it('refuses once the org is already at its concurrency cap, with a message that never says quota', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: 1 });
    await makeRunningRun(projectId); // fills the org's only slot
    const runId = await makeRunningRun(projectId);

    await expect(assertOrgConcurrencyAdmitted(getDb(), orgId, runId)).rejects.toThrow(
      /concurrency limit/i,
    );
    await expect(assertOrgConcurrencyAdmitted(getDb(), orgId, runId)).rejects.not.toThrow(
      /quota|rate.limit/i,
    );
  });

  it('is unlimited when max_concurrent_runs is null, however many runs are already going', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: null });
    await makeRunningRun(projectId);
    await makeRunningRun(projectId);
    await makeRunningRun(projectId);
    const runId = await makeRunningRun(projectId);

    await expect(assertOrgConcurrencyAdmitted(getDb(), orgId, runId)).resolves.toBeUndefined();
  });

  it('refuses a run id that never occupied a slot, once the org is already at its cap', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: 1 });
    await makeRunningRun(projectId);

    await expect(assertOrgConcurrencyAdmitted(getDb(), orgId, -1)).rejects.toThrow(
      /concurrency limit/i,
    );
  });

  // Ranking correctness under real concurrent execution: fire N already-
  // `running` rows' admission checks as genuinely concurrent promises
  // (Promise.allSettled, not two sequential awaits) and confirm exactly
  // `cap` of them are admitted - and deterministically the `cap` with the
  // LOWEST run id (insertion order), never an arbitrary subset. The N
  // inserts above are themselves fired concurrently too, so array index
  // does not track assigned id order - sort by the actual id Postgres
  // handed back before asserting who won.
  async function raceChecks(orgId: number, runIds: number[]) {
    const outcomes = await Promise.allSettled(
      runIds.map((id) => assertOrgConcurrencyAdmitted(getDb(), orgId, id)),
    );
    return runIds.map((id, i) => ({ id, status: outcomes[i].status })).sort((a, b) => a.id - b.id);
  }

  it('concurrently checking N running rows against cap 1 admits exactly the oldest one', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: 1 });
    const runIds = await Promise.all([1, 2, 3].map(() => makeRunningRun(projectId)));

    const ranked = await raceChecks(orgId, runIds);

    expect(ranked.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
  });

  it('concurrently checking N running rows against cap 2 admits exactly the 2 oldest', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: 2 });
    const runIds = await Promise.all([1, 2, 3, 4].map(() => makeRunningRun(projectId)));

    const ranked = await raceChecks(orgId, runIds);

    expect(ranked.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected']);
  });

  // The actual TOCTOU bug (#485): two dispatches deciding "may this org
  // start a run" at the same time, each reading a snapshot that does not
  // yet include the other. A timing race against a real (fast, local)
  // Postgres is not reliable proof by itself - both round trips can land
  // microseconds apart and never overlap. This instead CONTROLS the
  // overlap: a raw client takes the exact `pg_advisory_xact_lock` key
  // `assertOrgConcurrencyAdmitted` takes internally and holds it open, then
  // a genuinely concurrent call into the real function is proven to block
  // behind it rather than racing past on a plain read - and to proceed the
  // instant the lock is released. A count-then-decide implementation with
  // no locking at all would resolve immediately regardless of the held
  // lock, so this fails exactly the way #485's original bug would.
  it('a concurrent admission decision for the same org is serialized by a real Postgres lock, not an optimistic read (#485)', async () => {
    const { orgId, projectId } = await setupOrg({ maxConcurrentRuns: 5 });
    const runId = await makeRunningRun(projectId);

    const holder = await getPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `org-concurrency:${orgId}`,
      ]);

      let settled = false;
      const checkPromise = assertOrgConcurrencyAdmitted(getDb(), orgId, runId).finally(() => {
        settled = true;
      });

      // Give the check every chance to run if it were not actually blocked.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);

      await holder.query('COMMIT'); // releases the advisory lock
      await expect(checkPromise).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      holder.release();
    }
  });
});
