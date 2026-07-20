// Exercises shared/src/org-quota.ts: the month-to-date run-cost sum and the
// quota snapshot (CLD-P5, docs/cloud-runner-productionization-design.md
// section 5) minted into the runner JWT's `quota` claim
// (shared/src/agents/cloud/jwt.ts via shared/src/agents/cloud.ts). Each test
// creates its own organization + project (unique slug) rather than reusing
// the seeded 'default' org, and cleans up via cascade delete on the org -
// this DB is shared across test files and teardown intentionally leaves data
// for inspection.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  getOrgMonthToDateCostUsd,
  getOrgQuotaFields,
  getOrgQuotaSnapshot,
  setOrgQuota,
  startOfMonthUtc,
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

async function setupOrg(
  opts: { monthlyRunBudgetUsd?: string | null; maxConcurrentRuns?: number | null } = {},
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

/** A second project in the same org, so a campaign can be anchored to a
 * DIFFERENT project than the one a run's own `projectId` points at - the
 * scenario that exposes the double-count bug in the old
 * `innerJoin(projects, or(...))` query shape. */
async function setupOrgWithTwoProjects() {
  const db = getDb();
  const slug = `org-quota-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
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

describe('getOrgMonthToDateCostUsd', () => {
  it('sums only this org runs started on or after the first of the month', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    const thisMonthEarly = new Date('2026-07-01T00:00:00Z');
    const thisMonthLate = new Date('2026-07-14T00:00:00Z');
    const lastMonth = new Date('2026-06-30T23:59:59Z');

    await makeRun({ projectId, costUsd: '1.5000', startedAt: thisMonthEarly });
    await makeRun({ projectId, costUsd: '2.2500', startedAt: thisMonthLate });
    await makeRun({ projectId, costUsd: '99.0000', startedAt: lastMonth });

    const total = await getOrgMonthToDateCostUsd(getDb(), orgId, now);
    expect(total).toBeCloseTo(3.75, 4);
  });

  it('treats a null cost_usd (no usage reported) as 0', async () => {
    const { orgId, projectId } = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId, costUsd: null, startedAt: new Date('2026-07-02T00:00:00Z') });
    await makeRun({ projectId, costUsd: '4.0000', startedAt: new Date('2026-07-03T00:00:00Z') });

    const total = await getOrgMonthToDateCostUsd(getDb(), orgId, now);
    expect(total).toBeCloseTo(4.0, 4);
  });

  it('returns 0 for an org with no runs at all', async () => {
    const { orgId } = await setupOrg();
    const total = await getOrgMonthToDateCostUsd(getDb(), orgId, new Date('2026-07-15T12:00:00Z'));
    expect(total).toBe(0);
  });

  it('never counts a different org run, even started the same month', async () => {
    const orgA = await setupOrg();
    const orgB = await setupOrg();
    const now = new Date('2026-07-15T12:00:00Z');
    await makeRun({ projectId: orgA.projectId, costUsd: '10.0000', startedAt: now });
    await makeRun({ projectId: orgB.projectId, costUsd: '20.0000', startedAt: now });

    expect(await getOrgMonthToDateCostUsd(getDb(), orgA.orgId, now)).toBeCloseTo(10, 4);
    expect(await getOrgMonthToDateCostUsd(getDb(), orgB.orgId, now)).toBeCloseTo(20, 4);
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

    const total = await getOrgMonthToDateCostUsd(getDb(), orgId, now);
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

    const total = await getOrgMonthToDateCostUsd(getDb(), orgId, now);
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

    expect(await getOrgMonthToDateCostUsd(getDb(), orgA.orgId, now)).toBeCloseTo(10, 4);
    expect(await getOrgMonthToDateCostUsd(getDb(), orgB.orgId, now)).toBeCloseTo(20, 4);
  });
});

describe('getOrgQuotaSnapshot', () => {
  it('computes remainingUsd as budget minus month-to-date spend when a budget is set', async () => {
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
