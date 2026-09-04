import { describe, expect, it, beforeEach } from 'vitest';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

// linkedinCandidatesRun (the linkedin_candidates MCP tool) drains
// observed_targets - rows the browser already wrote to the observation
// buffer - into staging_scout_candidates for a run. Unlike
// mastodon-scout.test.ts, there is no network client to mock: this file
// exercises the real claim + filter + stage logic against Postgres.

async function reset() {
  const db = getDb();
  // Deliberately does not truncate `platforms`: tests share one Postgres
  // across files run sequentially, and other suites rely on the
  // core-seeded reddit/hackernews/mastodon/linkedin rows surviving between
  // files.
  await db.execute(
    sql`TRUNCATE runs, campaigns, projects, blocklist, contact_history, staging_scout_candidates, observed_targets RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function linkedinPlatformId(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  if (!row) throw new Error('linkedin platform not seeded by seed:core');
  return row.id;
}

async function defaultOrgId(): Promise<number> {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

/** Seeds a project plus one campaign/run pair bound to it, mirroring how startRun creates a campaign run (campaignId set, runs.projectId left null). */
async function seedRun(projectId: number, platformId: number, name: string) {
  const db = getDb();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId, platformId, name, skillSlug: 'linkedin-commenter' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual' })
    .returning();
  return { campaignId: campaign.id, runId: run.id };
}

async function seedProject(orgId: number, slug: string) {
  const db = getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug })
    .returning();
  return project.id;
}

async function seedObserved(opts: {
  organizationId: number;
  projectId: number;
  platformId: number;
  externalId: string;
  authorHandle?: string | null;
  observedAt?: Date;
}) {
  const db = getDb();
  const [row] = await db
    .insert(schema.observedTargets)
    .values({
      organizationId: opts.organizationId,
      projectId: opts.projectId,
      platformId: opts.platformId,
      externalId: opts.externalId,
      url: `https://www.linkedin.com/feed/update/${opts.externalId}/`,
      authorHandle: opts.authorHandle ?? null,
      authorName: opts.authorHandle ? `${opts.authorHandle} display name` : null,
      text: `body of ${opts.externalId}`,
      observedAt: opts.observedAt ?? new Date(),
    })
    .returning();
  return row;
}

beforeEach(reset);

describe('linkedinCandidatesRun', () => {
  it('throws when the run does not exist', async () => {
    const { linkedinCandidatesRun } = await import('../../src/commands/linkedin.js');
    await expect(linkedinCandidatesRun({ runId: 987654 })).rejects.toThrow('not found');
  });

  it('returns an empty list rather than an error when the buffer is empty', async () => {
    const orgId = await defaultOrgId();
    const platformId = await linkedinPlatformId();
    const projectId = await seedProject(orgId, 'li-empty');
    const { runId } = await seedRun(projectId, platformId, 'LinkedIn Commenter');

    const { linkedinCandidatesRun } = await import('../../src/commands/linkedin.js');
    await expect(linkedinCandidatesRun({ runId })).resolves.toEqual({
      runId,
      candidatesFetched: 0,
    });
  });

  it('stages an observed post and never returns the consumed row again', async () => {
    const orgId = await defaultOrgId();
    const platformId = await linkedinPlatformId();
    const projectId = await seedProject(orgId, 'li-consume');
    const { runId } = await seedRun(projectId, platformId, 'LinkedIn Commenter');
    await seedObserved({
      organizationId: orgId,
      projectId,
      platformId,
      externalId: 'urn:li:activity:1',
      authorHandle: 'alice',
    });

    const { linkedinCandidatesRun } = await import('../../src/commands/linkedin.js');
    const first = await linkedinCandidatesRun({ runId });
    expect(first).toEqual({ runId, candidatesFetched: 1 });

    const db = getDb();
    const staged = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    expect(staged).toHaveLength(1);
    expect(staged[0]?.raw).toMatchObject({
      author: { handle: 'alice' },
      post: { externalId: 'urn:li:activity:1' },
    });

    // Same run, called again: the row is already consumed, so it must not
    // be staged a second time.
    const second = await linkedinCandidatesRun({ runId });
    expect(second).toEqual({ runId, candidatesFetched: 0 });
    const stagedAfter = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    expect(stagedAfter).toHaveLength(1);
  });

  it('claims a blocklisted author but never stages it', async () => {
    const orgId = await defaultOrgId();
    const platformId = await linkedinPlatformId();
    const projectId = await seedProject(orgId, 'li-blocklist');
    const { runId } = await seedRun(projectId, platformId, 'LinkedIn Commenter');
    const db = getDb();
    await db.insert(schema.blocklist).values({
      platformId,
      kind: 'user',
      value: 'spammer',
      reason: 'spam',
    });
    const observed = await seedObserved({
      organizationId: orgId,
      projectId,
      platformId,
      externalId: 'urn:li:activity:2',
      authorHandle: 'spammer',
    });

    const { linkedinCandidatesRun } = await import('../../src/commands/linkedin.js');
    const result = await linkedinCandidatesRun({ runId });
    expect(result).toEqual({ runId, candidatesFetched: 0 });

    const staged = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    expect(staged).toHaveLength(0);

    // Claimed (consumed) even though filtered, so it is never re-offered.
    const [row] = await db
      .select()
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.id, observed.id));
    expect(row?.consumedByRunId).toBe(runId);
  });

  it('filters a target contacted inside the dedup window', async () => {
    const orgId = await defaultOrgId();
    const platformId = await linkedinPlatformId();
    const projectId = await seedProject(orgId, 'li-dedup');
    const { runId } = await seedRun(projectId, platformId, 'LinkedIn Commenter');
    const db = getDb();
    await db.insert(schema.contactHistory).values({
      platformId,
      accountHandle: 'our-linkedin-profile',
      targetUser: 'bob',
      organizationId: orgId,
      lastContactedAt: new Date(),
    });
    await seedObserved({
      organizationId: orgId,
      projectId,
      platformId,
      externalId: 'urn:li:activity:3',
      authorHandle: 'bob',
    });

    const { linkedinCandidatesRun } = await import('../../src/commands/linkedin.js');
    const result = await linkedinCandidatesRun({ runId });
    expect(result).toEqual({ runId, candidatesFetched: 0 });

    const staged = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    expect(staged).toHaveLength(0);
  });

  it('two concurrent drains of the same project never claim the same row', async () => {
    const orgId = await defaultOrgId();
    const platformId = await linkedinPlatformId();
    const projectId = await seedProject(orgId, 'li-concurrent');
    const { runId: runIdA } = await seedRun(projectId, platformId, 'Campaign A');
    const { runId: runIdB } = await seedRun(projectId, platformId, 'Campaign B');

    const db = getDb();
    const externalIds = Array.from({ length: 6 }, (_, i) => `urn:li:activity:concurrent-${i}`);
    for (const [i, externalId] of externalIds.entries()) {
      // Distinct authors so nothing is filtered by blocklist/dedup - the
      // point of this test is the claim race, not the filters.
      await seedObserved({
        organizationId: orgId,
        projectId,
        platformId,
        externalId,
        authorHandle: `author-${i}`,
        // Stagger observedAt so ordering is deterministic if either call
        // drains everything on its own.
        observedAt: new Date(Date.now() - (externalIds.length - i) * 1000),
      });
    }

    const { linkedinCandidatesRun } = await import('../../src/commands/linkedin.js');
    // Each call asks for more than half the buffer (4 of 6), so if both
    // transactions claimed the same rows without excluding each other's
    // in-flight claim, the totals would double-count and/or the same
    // external_id would land in both runs' staged candidates.
    const [resultA, resultB] = await Promise.all([
      linkedinCandidatesRun({ runId: runIdA, limit: 4 }),
      linkedinCandidatesRun({ runId: runIdB, limit: 4 }),
    ]);

    expect(resultA.candidatesFetched + resultB.candidatesFetched).toBe(6);

    const stagedA = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runIdA));
    const stagedB = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runIdB));
    const idsA = stagedA.map((s) => {
      const raw = s.raw as { post: { externalId: string } }; // shape this test inserted above
      return raw.post.externalId;
    });
    const idsB = stagedB.map((s) => {
      const raw = s.raw as { post: { externalId: string } }; // shape this test inserted above
      return raw.post.externalId;
    });
    expect(idsA).toHaveLength(resultA.candidatesFetched);
    expect(idsB).toHaveLength(resultB.candidatesFetched);
    // No external_id claimed by both runs.
    expect(idsA.filter((id) => idsB.includes(id))).toHaveLength(0);
    // Every row in the buffer ended up consumed by exactly one of the two runs.
    const rows = await db
      .select({ consumedByRunId: schema.observedTargets.consumedByRunId })
      .from(schema.observedTargets)
      .where(eq(schema.observedTargets.projectId, projectId));
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.consumedByRunId === runIdA || r.consumedByRunId === runIdB)).toBe(
      true,
    );
  });
});
