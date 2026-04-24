import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, stdin?: string): string {
  return execSync(`npm -s run -w @pitchbox/cli dev -- ${args}`, {
    encoding: 'utf8',
    input: stdin,
    cwd: '/Users/lorenzofiore/Progetti/Personale/pitchbox',
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
    const [platform] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db.insert(schema.projects).values({ slug: 'demo', name: 'D' }).returning();
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
});

afterAll(async () => {
  await getPool().end();
});
