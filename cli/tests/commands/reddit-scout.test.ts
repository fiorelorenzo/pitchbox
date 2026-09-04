import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

// scoutRun (the reddit_scout MCP tool) loads the run/campaign, resolves the
// blocklist + contact history into plain sets, delegates the actual Reddit
// discovery + filtering (including the #338 recency cap) to the shared
// runScout, and stages the results. The shared platform module is mocked so
// this test never touches the network or a browser; runScout's own recency
// filtering is covered directly in shared/tests/platforms/reddit/filter.test.ts.
// This file only proves the campaign-config -> runScout wiring, in particular
// that an existing campaign with no `maxPostAgeHours` key still reaches the
// scout as "absent" rather than "no cap" (that distinction is the shared
// filter's job, not this file's - see filter.test.ts's "falls back to the
// default cap" case).

const runScout = vi.fn();

vi.mock('@pitchbox/shared/platforms/reddit', async () => {
  const actual = await vi.importActual<typeof import('@pitchbox/shared/platforms/reddit')>(
    '@pitchbox/shared/platforms/reddit',
  );
  return { ...actual, runScout };
});

async function reset() {
  const db = getDb();
  // Deliberately does not truncate `platforms`: tests share one Postgres
  // across files run sequentially, and other suites rely on the
  // core-seeded reddit/hackernews/mastodon rows surviving between files.
  await db.execute(
    sql`TRUNCATE runs, campaigns, accounts, projects, blocklist, contact_history, staging_scout_candidates RESTART IDENTITY CASCADE`,
  );
}

async function redditPlatformId(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  return row.id;
}

async function seedRun(config: Record<string, unknown>) {
  const db = getDb();
  const platformId = await redditPlatformId();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'reddit-scout-test', name: 'Reddit Scout Test' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId,
      name: 'Reddit Scout',
      skillSlug: 'reddit-scout',
      config,
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, projectId: project.id, trigger: 'manual' })
    .returning();
  return {
    platformId,
    projectId: project.id,
    campaignId: campaign.id,
    runId: run.id,
    orgId: org.id,
  };
}

beforeEach(async () => {
  await reset();
  runScout.mockReset();
  runScout.mockResolvedValue({ candidates: [], droppedByAge: 0 });
});

describe('reddit scoutRun', () => {
  it('throws when the run does not exist', async () => {
    const { scoutRun } = await import('../../src/commands/reddit.js');
    await expect(scoutRun(987654)).rejects.toThrow('not found');
  });

  it('throws when the campaign config has no targetSubreddits', async () => {
    const { scoutRun } = await import('../../src/commands/reddit.js');
    const { runId } = await seedRun({});
    await expect(scoutRun(runId)).rejects.toThrow('targetSubreddits');
  });

  it('passes an explicit maxPostAgeHours from campaign config through to runScout', async () => {
    const { runId } = await seedRun({ targetSubreddits: ['rpg'], maxPostAgeHours: 24 });

    const { scoutRun } = await import('../../src/commands/reddit.js');
    await scoutRun(runId);

    expect(runScout).toHaveBeenCalledTimes(1);
    const call = runScout.mock.calls[0][0];
    expect(call.profile.maxPostAgeHours).toBe(24);
  });

  it('leaves maxPostAgeHours undefined for an existing campaign whose config predates the key', async () => {
    const { runId } = await seedRun({ targetSubreddits: ['rpg'] });

    const { scoutRun } = await import('../../src/commands/reddit.js');
    await scoutRun(runId);

    const call = runScout.mock.calls[0][0];
    // Absent, not a "no cap" sentinel like 0 or a huge number - the shared
    // filter is the one that turns "absent" into "default 72h".
    expect(call.profile.maxPostAgeHours).toBeUndefined();
  });

  it('resolves blocklist + contact history and stages candidates from runScout', async () => {
    const db = getDb();
    const { platformId, runId, orgId } = await seedRun({ targetSubreddits: ['rpg'] });
    await db
      .insert(schema.blocklist)
      .values([{ platformId, kind: 'user', value: 'spammer', reason: 'spam' }]);
    await db.insert(schema.contactHistory).values({
      platformId,
      accountHandle: 'our-account',
      targetUser: 'already-contacted',
      organizationId: orgId,
    });

    runScout.mockResolvedValue({
      candidates: [{ user: { name: 'alice' }, post: { permalink: '/r/rpg/1' } }],
      droppedByAge: 2,
    });

    const { scoutRun } = await import('../../src/commands/reddit.js');
    const result = await scoutRun(runId);

    expect(result).toEqual({ runId, candidatesFetched: 1, droppedByAge: 2 });
    const call = runScout.mock.calls[0][0];
    expect([...call.blockedHandles]).toEqual(['spammer']);
    expect([...call.contactedHandles]).toEqual(['already-contacted']);

    const staged = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    expect(staged).toHaveLength(1);
    expect(staged[0]?.raw).toMatchObject({ user: { name: 'alice' } });
  });
});
