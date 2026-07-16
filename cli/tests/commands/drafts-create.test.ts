import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, stdin?: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input: stdin,
    cwd: process.cwd(),
  });
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

describe('pitchbox drafts:create', () => {
  beforeEach(reset);

  it('bulk-inserts drafts from stdin JSON', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo', name: 'D' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'alice', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        fitScore: 4,
        subreddit: 'rpg',
        targetUser: 'bob',
        body: 'hey bob, ...',
        reasoning: 'matched post',
        composeUrl: 'https://reddit.com/message/compose?to=bob&subject=hi',
        sourceRef: { permalink: '/r/rpg/p/1' },
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].state).toBe('pending_review');
    expect(drafts[0].targetUser).toBe('bob');
    expect(drafts[0].metadata).toMatchObject({ subreddit: 'rpg' });
    // No qualityScore supplied - persists as null (not scored).
    expect(drafts[0].qualityScore).toBeNull();
    expect(drafts[0].qualityReason).toBeNull();
    expect(drafts[0].qualityModel).toBeNull();
  });

  it('persists an inline quality score supplied at creation (issue #41)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo3', name: 'D3' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: project.id, platformId: platform.id, handle: 'carol', role: 'personal' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c3',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'dave',
        body: 'hey dave, ...',
        sourceRef: {},
        metadata: {},
        qualityScore: 82,
        qualityReason: 'specific and personal',
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].qualityScore).toBe(82);
    expect(drafts[0].qualityReason).toBe('specific and personal');
    expect(drafts[0].qualityModel).toBe(run.agentRunner);
  });

  it('skips blocklisted targets and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'demo2', name: 'D2' })
      .returning();
    const [account] = await db
      .insert(schema.accounts)
      .values({
        projectId: project.id,
        platformId: platform.id,
        handle: 'sender',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'c2',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Insert blocklist entry for 'Bob' (mixed case) - should block 'bob' (lowercase) in the input
    await db.insert(schema.blocklist).values({
      platformId: platform.id,
      projectId: project.id,
      kind: 'user',
      value: 'Bob',
      scope: 'global',
      reason: 'asked-not-to-contact',
    });

    const payload = JSON.stringify([
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'alice',
        body: 'hey alice, ...',
        sourceRef: {},
        metadata: {},
      },
      {
        accountId: account.id,
        kind: 'dm',
        targetUser: 'bob',
        body: 'hey bob, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, payload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);
    expect(res.data.skipped).toHaveLength(1);
    expect(res.data.skipped[0].targetUser).toBe('bob');
    expect(res.data.skipped[0].reason).toBe('asked-not-to-contact');

    // Only alice's draft should be in the DB; no draft or draft_event for bob
    const drafts = await db.select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetUser).toBe('alice');
    const events = await db.select().from(schema.draftEvents);
    expect(events).toHaveLength(1);
    expect(events[0].draftId).toBe(drafts[0].id);
  });

  it('rejects a draft whose accountId belongs to a different project (issue #107)', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);

    // Project A owns the campaign/run.
    const [projectA] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'proj-a', name: 'Project A' })
      .returning();
    const [accountA] = await db
      .insert(schema.accounts)
      .values({
        projectId: projectA.id,
        platformId: platform.id,
        handle: 'a-owner',
        role: 'personal',
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: projectA.id,
        platformId: platform.id,
        name: 'ca',
        skillSlug: 'reddit-scout',
        config: {},
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'running' })
      .returning();

    // Project B owns a foreign account that should never be attributable to
    // project A's drafts.
    const [projectB] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'proj-b', name: 'Project B' })
      .returning();
    const [accountB] = await db
      .insert(schema.accounts)
      .values({
        projectId: projectB.id,
        platformId: platform.id,
        handle: 'b-owner',
        role: 'personal',
      })
      .returning();

    // Foreign accountId is rejected: the whole batch fails with a clear error
    // and nothing is persisted.
    const foreignPayload = JSON.stringify([
      {
        accountId: accountB.id,
        kind: 'dm',
        targetUser: 'eve',
        body: 'hey eve, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    let threw = false;
    try {
      cli(`drafts:create --run=${run.id}`, foreignPayload);
    } catch (err) {
      threw = true;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      const res = JSON.parse(stderr.trim().split('\n').at(-1)!);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/account/i);
      expect(res.error).toMatch(new RegExp(String(accountB.id)));
    }
    expect(threw).toBe(true);

    const draftsAfterForeign = await db.select().from(schema.drafts);
    expect(draftsAfterForeign).toHaveLength(0);

    // Same-project accountId succeeds as before.
    const samePayload = JSON.stringify([
      {
        accountId: accountA.id,
        kind: 'dm',
        targetUser: 'frank',
        body: 'hey frank, ...',
        sourceRef: {},
        metadata: {},
      },
    ]);

    const out = cli(`drafts:create --run=${run.id}`, samePayload);
    const lines = out.trim().split('\n');
    const res = JSON.parse(lines[lines.length - 1]);
    expect(res.ok).toBe(true);
    expect(res.data.inserted).toBe(1);

    const draftsAfterSame = await db.select().from(schema.drafts);
    expect(draftsAfterSame).toHaveLength(1);
    expect(draftsAfterSame[0].accountId).toBe(accountA.id);
  });
});

afterAll(async () => {
  await getPool().end();
});
