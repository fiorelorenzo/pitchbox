import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, stdin?: string): string {
  return execSync(`npm -s run -w @pitchbox/cli dev -- ${args}`, {
    encoding: 'utf8',
    input: stdin,
    cwd: process.cwd(),
  });
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, project_configs, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
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
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'demo', name: 'D' })
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
  });

  it('skips blocklisted targets and reports them in the response', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'demo2', name: 'D2' })
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

    // Insert blocklist entry for 'Bob' (mixed case) — should block 'bob' (lowercase) in the input
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
});

afterAll(async () => {
  await getPool().end();
});
