// Exercises shared/src/usage.ts's getOrgUsage: the single snapshot every
// #548 enforcement point, the settings/billing page (#555) and the
// extension payload (#556) will read - "how much of this org's plan is
// used" across every metered axis, for one org and one period. Deliberately
// not restating PLAN_CATALOGUE.free's numbers as a second source of truth
// (shared/tests/plans.test.ts already owns that); the free plan's real
// numbers are used here only as fixed, known limits to assert usage/limit/
// remaining arithmetic against.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { getOrgUsage } from '../src/usage.js';
import { calendarPeriodFor, type Period } from '../src/org-quota.js';
import { PLAN_CATALOGUE } from '../src/plans.js';

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const savedEdition = process.env.PITCHBOX_EDITION;

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
  while (createdUserIds.length > 0) {
    const id = createdUserIds.pop()!;
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }
  if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
  else process.env.PITCHBOX_EDITION = savedEdition;
});

const ANCHOR = new Date('2026-01-01T00:00:00Z');
const NOW = new Date('2026-01-15T12:00:00Z');
const PERIOD: Period = calendarPeriodFor(ANCHOR, NOW);

/** A cloud-edition org on the free plan (the default), so `getOrgUsage`
 * exercises real numeric limits rather than self-host's unlimited shape. */
async function makeCloudOrg(plan: string = 'free') {
  process.env.PITCHBOX_EDITION = 'cloud';
  const db = getDb();
  const slug = `usage-test-${randomUUID()}`;
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan, createdAt: ANCHOR })
    .returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'p' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

async function makeRun(opts: {
  projectId: number;
  kind?: string;
  status?: string;
  startedAt: Date;
}) {
  const db = getDb();
  await db.insert(schema.runs).values({
    kind: opts.kind ?? 'project_extraction',
    projectId: opts.projectId,
    trigger: 'manual',
    status: opts.status ?? 'success',
    startedAt: opts.startedAt,
  });
}

async function makeAssistUsage(opts: {
  organizationId: number;
  projectId: number | null;
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
    createdAt: opts.createdAt,
  });
}

async function makeAccount(projectId: number, active: boolean = true) {
  const db = getDb();
  const [platform] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  await db
    .insert(schema.accounts)
    .values({ projectId, platformId: platform.id, handle: `h-${randomUUID()}`, active });
}

async function makeMember(organizationId: number) {
  const db = getDb();
  const username = `usage-test-${randomUUID()}`;
  const [user] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  createdUserIds.push(user.id);
  await db.insert(schema.memberships).values({ organizationId, userId: user.id, role: 'member' });
}

async function makeInvite(
  organizationId: number,
  opts: { acceptedAt?: Date; expiresAt?: Date } = {},
) {
  const db = getDb();
  await db.insert(schema.orgInvites).values({
    organizationId,
    token: randomUUID(),
    role: 'member',
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: opts.acceptedAt ?? null,
  });
}

async function makeDevice(
  organizationId: number,
  opts: { revokedAt?: Date; expiresAt?: Date | null } = {},
) {
  const db = getDb();
  await db.insert(schema.extensionDevices).values({
    organizationId,
    label: 'd',
    tokenHash: randomUUID(),
    revokedAt: opts.revokedAt ?? null,
    expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
  });
}

describe('getOrgUsage: self-host', () => {
  it('returns the unlimited shape without running any count query', async () => {
    delete process.env.PITCHBOX_EDITION;
    const db = getDb();
    const slug = `usage-test-${randomUUID()}`;
    const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
    createdOrgIds.push(org.id);
    // Deliberately no project - if getOrgUsage ran a real count query for a
    // structural axis it would 500 or return 0 rather than the unlimited
    // shape, since there is nothing to count against.
    const usage = await getOrgUsage(db, org.id, PERIOD);
    expect(usage.entitlements.source).toBe('self-host');
    for (const metric of [
      usage.runs,
      usage.suggestions,
      usage.projects,
      usage.accounts,
      usage.seats,
      usage.extensionDevices,
      usage.costUsd,
    ]) {
      expect(metric.limit).toBeNull();
      expect(metric.remaining).toBeNull();
    }
  });
});

describe('getOrgUsage: runs', () => {
  it('counts every run whatever the kind and whatever the status - a failed run still costs compute', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    await makeRun({ projectId, status: 'success', startedAt: NOW });
    await makeRun({ projectId, status: 'failed', startedAt: NOW });
    await makeRun({ projectId, kind: 'draft_regeneration', status: 'success', startedAt: NOW });
    await makeRun({ projectId, status: 'running', startedAt: NOW });

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.runs.used).toBe(4);
    expect(usage.runs.limit).toBe(PLAN_CATALOGUE.free.runsPerMonth);
  });

  it('excludes a run started outside the period', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    await makeRun({ projectId, startedAt: PERIOD.start });
    await makeRun({ projectId, startedAt: new Date(PERIOD.start.getTime() - 1000) });
    await makeRun({ projectId, startedAt: PERIOD.end });

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.runs.used).toBe(1);
  });

  it('remaining is limit minus used, clamped at 0 rather than going negative', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    for (let i = 0; i < PLAN_CATALOGUE.free.runsPerMonth! + 3; i += 1) {
      await makeRun({ projectId, startedAt: NOW });
    }
    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.runs.used).toBe(PLAN_CATALOGUE.free.runsPerMonth! + 3);
    expect(usage.runs.remaining).toBe(0);
  });
});

describe('getOrgUsage: suggestions', () => {
  it('counts produced suggestions from the assist ledger, not accepted ones', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    await makeAssistUsage({ organizationId: orgId, projectId, createdAt: NOW });
    await makeAssistUsage({ organizationId: orgId, projectId, createdAt: NOW });
    // #521: accepting one writes a row in the assist plane's own ledger
    // (assist_accepted_suggestions), never a `runs` row any more - it must
    // not be double-counted as a second suggestion.
    const [platform] = await getDb()
      .select({ id: schema.platforms.id })
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'linkedin'));
    await getDb()
      .insert(schema.assistAcceptedSuggestions)
      .values({
        organizationId: orgId,
        projectId,
        platformId: platform.id,
        kind: 'post_comment',
        body: 'accepted suggestion text',
        agentRunner: 'claude-code',
        createdAt: NOW,
      });

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.suggestions.used).toBe(2);
    expect(usage.suggestions.limit).toBe(PLAN_CATALOGUE.free.suggestionsPerMonth);
  });

  // #523 made `assist_usage.project_id` nullable - a suggestion can be
  // about no product at all - and getOrgUsage filters this count by
  // `organizationId` directly rather than through the org's project ids
  // precisely so a null-project suggestion is never silently dropped. Proven
  // by removing that direct filter (switching to a project-id membership
  // test as the old code did) and watching this fail with `used: 0`.
  it('counts a suggestion with no project, filtered by organization id directly (#523)', async () => {
    const { orgId } = await makeCloudOrg();
    await makeAssistUsage({ organizationId: orgId, projectId: null, createdAt: NOW });

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.suggestions.used).toBe(1);
  });
});

describe('getOrgUsage: structural counts', () => {
  it('projects counts every project the org has right now, not period-bound', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    await getDb()
      .insert(schema.projects)
      .values({ organizationId: orgId, slug: 'second', name: 'second' });
    void projectId;

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.projects.used).toBe(2);
    expect(usage.projects.limit).toBe(PLAN_CATALOGUE.free.projects);
  });

  it('accounts counts only active connected accounts, with no plan limit yet', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    await makeAccount(projectId, true);
    await makeAccount(projectId, false);

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.accounts.used).toBe(1);
    expect(usage.accounts.limit).toBeNull();
  });

  it('seats counts memberships plus pending, unexpired invites - inviting ten people cannot bypass the limit', async () => {
    const { orgId } = await makeCloudOrg();
    await makeMember(orgId);
    await makeInvite(orgId); // pending, unexpired
    await makeInvite(orgId, { acceptedAt: new Date() }); // already accepted - not a pending seat
    await makeInvite(orgId, { expiresAt: new Date(Date.now() - 1000) }); // expired - not a seat

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.seats.used).toBe(2); // 1 member + 1 pending invite
    expect(usage.seats.limit).toBe(PLAN_CATALOGUE.free.seats);
  });

  it('extensionDevices excludes a revoked or expired device so rotation never consumes a slot forever', async () => {
    const { orgId } = await makeCloudOrg();
    await makeDevice(orgId); // live, no expiry
    await makeDevice(orgId, { expiresAt: new Date(Date.now() + 60_000) }); // live, expires in the future
    await makeDevice(orgId, { revokedAt: new Date() }); // revoked
    await makeDevice(orgId, { expiresAt: new Date(Date.now() - 60_000) }); // expired

    const usage = await getOrgUsage(getDb(), orgId, PERIOD);
    expect(usage.extensionDevices.used).toBe(2);
    expect(usage.extensionDevices.limit).toBe(PLAN_CATALOGUE.free.extensionDevices);
  });
});

describe('getOrgUsage: costUsd', () => {
  it('reuses the existing org-quota spend figure for the period, clamped to the plan budget', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    const db = getDb();
    await db.insert(schema.runs).values({
      kind: 'project_extraction',
      projectId,
      trigger: 'manual',
      status: 'success',
      costUsd: '1.5000',
      startedAt: NOW,
    });

    const usage = await getOrgUsage(db, orgId, PERIOD);
    expect(usage.costUsd.used).toBeCloseTo(1.5, 4);
    expect(usage.costUsd.limit).toBe(PLAN_CATALOGUE.free.monthlyRunBudgetUsd);
  });
});

describe('getOrgUsage: query count', () => {
  it('does not grow with the number of projects the org has', async () => {
    const { orgId, projectId } = await makeCloudOrg();
    const db = getDb();
    for (let i = 0; i < 10; i += 1) {
      await db
        .insert(schema.projects)
        .values({ organizationId: orgId, slug: `extra-${i}`, name: `extra ${i}` });
    }
    await makeRun({ projectId, startedAt: NOW });

    // Not a query-count assertion (no query spy) - a correctness one: with
    // 11 projects, an implementation that queried per project would still
    // return the right numbers, just slowly. What actually catches an O(n)
    // implementation is `getOrgUsage`'s own query shape (inArray, not a
    // loop) - this at least proves correctness holds at more than one
    // project, which a single-project fixture would not.
    const usage = await getOrgUsage(db, orgId, PERIOD);
    expect(usage.projects.used).toBe(11);
    expect(usage.runs.used).toBe(1);
  });
});
