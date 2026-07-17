import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

// scoutRun (the mastodon_scout MCP tool) mirrors reddit.ts's scoutRun: it
// loads the run/campaign, resolves the blocklist + contact history into
// plain sets, builds a MastodonClient, delegates the actual hashtag-timeline
// discovery + filtering to the shared runScout, and stages the results.
// The shared platform module is mocked so this test never touches the
// network; runScout's own filtering behavior is covered directly in
// shared/tests/platforms/mastodon/scout.test.ts.

const runScout = vi.fn();
const MastodonClient = vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
  Object.assign(this as object, { opts });
});

vi.mock('@pitchbox/shared/platforms/mastodon', () => ({
  runScout,
  MastodonClient,
}));

async function reset() {
  const db = getDb();
  // Deliberately does not truncate `platforms`: tests share one Postgres
  // across files run sequentially, and other suites rely on the
  // core-seeded reddit/hackernews rows surviving between files.
  await db.execute(
    sql`TRUNCATE runs, campaigns, accounts, projects, blocklist, contact_history, staging_scout_candidates RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function mastodonPlatformId(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .insert(schema.platforms)
    .values({ slug: 'mastodon' })
    .onConflictDoNothing()
    .returning();
  if (row) return row.id;
  const [existing] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'mastodon'));
  return existing.id;
}

async function seedRun(config: Record<string, unknown>) {
  const db = getDb();
  const platformId = await mastodonPlatformId();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'mastodon-test', name: 'Mastodon Test' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId,
      name: 'Mastodon Scout',
      skillSlug: 'mastodon-scout',
      config,
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, projectId: project.id, trigger: 'manual' })
    .returning();
  return { platformId, projectId: project.id, campaignId: campaign.id, runId: run.id };
}

beforeEach(async () => {
  await reset();
  runScout.mockReset();
  MastodonClient.mockClear();
  process.env.MASTODON_INSTANCE_URL = 'https://mastodon.example';
  process.env.MASTODON_ACCESS_TOKEN = 'test-token';
});

describe('mastodon scoutRun', () => {
  it('throws when the run does not exist', async () => {
    const { scoutRun } = await import('../../src/commands/mastodon.js');
    await expect(scoutRun(987654)).rejects.toThrow('not found');
  });

  it('throws when the campaign config has no targetHashtags', async () => {
    const { scoutRun } = await import('../../src/commands/mastodon.js');
    const { runId } = await seedRun({});
    await expect(scoutRun(runId)).rejects.toThrow('targetHashtags');
  });

  it('resolves blocklist + contact history and stages candidates from runScout', async () => {
    const db = getDb();
    const { platformId, runId } = await seedRun({
      targetHashtags: ['outreach'],
      keywords: ['crm'],
    });
    await db.insert(schema.blocklist).values([
      { platformId, kind: 'user', value: 'spammer', reason: 'spam' },
      { platformId, kind: 'keyword', value: 'crypto', reason: 'off-topic' },
    ]);
    await db.insert(schema.contactHistory).values({
      platformId,
      accountHandle: 'our-account',
      targetUser: 'already-contacted',
    });

    runScout.mockResolvedValue([
      { author: { acct: 'alice' }, status: { id: '1' }, matchedHashtag: 'outreach' },
    ]);

    const { scoutRun } = await import('../../src/commands/mastodon.js');
    const result = await scoutRun(runId);

    expect(result).toEqual({ runId, candidatesFetched: 1 });
    expect(MastodonClient).toHaveBeenCalledWith({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'test-token',
    });
    expect(runScout).toHaveBeenCalledTimes(1);
    const call = runScout.mock.calls[0][0];
    expect(call.hashtags).toEqual(['outreach']);
    expect(call.keywords).toEqual(['crm']);
    expect([...call.blockedHandles]).toEqual(['spammer']);
    expect([...call.blockedKeywords]).toEqual(['crypto']);
    expect([...call.contactedHandles]).toEqual(['already-contacted']);

    const staged = await db
      .select()
      .from(schema.stagingScoutCandidates)
      .where(eq(schema.stagingScoutCandidates.runId, runId));
    expect(staged).toHaveLength(1);
    expect(staged[0]?.raw).toMatchObject({ author: { acct: 'alice' } });
  });

  it('throws a clear error when Mastodon credentials are not configured', async () => {
    delete process.env.MASTODON_INSTANCE_URL;
    delete process.env.MASTODON_ACCESS_TOKEN;
    const { runId } = await seedRun({ targetHashtags: ['outreach'] });

    const { scoutRun } = await import('../../src/commands/mastodon.js');
    await expect(scoutRun(runId)).rejects.toThrow('MASTODON_INSTANCE_URL');
  });
});
