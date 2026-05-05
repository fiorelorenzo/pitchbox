import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cliWithStdin(args: string, input: string): string {
  return execSync(`npm -s run -w @pitchbox/cli dev -- ${args}`, {
    encoding: 'utf8',
    input,
    cwd: '/Users/lorenzofiore/Progetti/Personale/pitchbox',
  });
}

const VALID_SCOUT_PROFILE = {
  targetSubreddits: ['rpg'],
  topicKeywords: ['ai dm'],
  avoidKeywords: [],
  fitScoreThreshold: 3,
  voice: {
    tone: 'casual',
    hardBans: ['—'],
    dos: ['use lowercase opener'],
    openerStyle: 'lowercase-casual',
    disclosure: 'i build this',
  },
  offer: {
    productUrl: 'https://example.com',
    subject: 'founding player invite',
    text: 'short pitch',
  },
  systemInstructions: 'no jargon',
};

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE runs, campaigns, projects RESTART IDENTITY CASCADE`);
}

describe('pitchbox skill:generate:finish', () => {
  let runId: number;
  let campaignId: number;

  beforeEach(async () => {
    await reset();
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'p', name: 'P' })
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
    campaignId = campaign.id;
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'campaign_skill_generation',
        campaignId,
        trigger: 'manual',
        status: 'running',
        params: { scenario: 'reddit-scout', objective: 'find players' },
      })
      .returning();
    runId = run.id;
  });

  it('writes config, marks run success, flips draft → active', async () => {
    const out = cliWithStdin(
      `skill:generate:finish --run=${runId}`,
      JSON.stringify(VALID_SCOUT_PROFILE),
    );
    const parsed = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(parsed.ok).toBe(true);
    const db = getDb();
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(c.config).toEqual(VALID_SCOUT_PROFILE);
    expect(c.status).toBe('active');
    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(r.status).toBe('success');
  });

  it('rejects invalid JSON with Zod issues', () => {
    const bad = { ...VALID_SCOUT_PROFILE, fitScoreThreshold: 99 };
    expect(() => cliWithStdin(`skill:generate:finish --run=${runId}`, JSON.stringify(bad))).toThrow();
  });

  it('does not flip status when campaign is already active', async () => {
    const db = getDb();
    await db
      .update(schema.campaigns)
      .set({ status: 'active' })
      .where(eq(schema.campaigns.id, campaignId));
    cliWithStdin(`skill:generate:finish --run=${runId}`, JSON.stringify(VALID_SCOUT_PROFILE));
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    expect(c.status).toBe('active');
  });
});

afterAll(async () => {
  await getPool().end();
});
