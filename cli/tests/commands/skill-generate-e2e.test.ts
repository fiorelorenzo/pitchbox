import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

const VALID_SCOUT_PROFILE = {
  targetSubreddits: ['rpg'],
  topicKeywords: ['ai dm'],
  avoidKeywords: [],
  fitScoreThreshold: 3,
  voice: {
    tone: 'casual',
    hardBans: [],
    dos: [],
    openerStyle: 'lowercase-casual',
    disclosure: 'i build this',
  },
  offer: {
    productUrl: 'https://example.com',
    subject: 'invite',
    text: 'short pitch',
  },
  systemInstructions: 'casual tone',
};

function cli(args: string, input?: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input,
    cwd: process.cwd(),
  });
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE runs, campaigns, projects RESTART IDENTITY CASCADE`);
}

describe('skill_generation end-to-end (stub)', () => {
  beforeEach(reset);

  it('start → finish writes config and flips draft → active', async () => {
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
      .values({ organizationId: org.id, slug: 'p', name: 'P', description: '# Demo' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: project.id,
        platformId: platform.id,
        name: 'C',
        skillSlug: 'reddit-scout',
        status: 'draft',
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'campaign_skill_generation',
        campaignId: campaign.id,
        trigger: 'manual',
        status: 'running',
        params: { scenario: 'reddit-scout', objective: 'find players' },
      })
      .returning();

    const start = JSON.parse(
      cli(`skill:generate:start --run=${run.id}`).trim().split('\n').at(-1)!,
    );
    expect(start.ok).toBe(true);

    const finish = JSON.parse(
      cli(`skill:generate:finish --run=${run.id}`, JSON.stringify(VALID_SCOUT_PROFILE))
        .trim()
        .split('\n')
        .at(-1)!,
    );
    expect(finish.ok).toBe(true);

    const [c] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    expect(c.status).toBe('active');
    expect(c.config).toEqual(VALID_SCOUT_PROFILE);
  });
});

afterAll(async () => {
  await getPool().end();
});
