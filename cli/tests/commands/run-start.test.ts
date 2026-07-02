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

function cli(args: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

describe('pitchbox run:start', () => {
  beforeEach(async () => {
    await reset();
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'test', name: 'Test' })
      .returning();
    await db.insert(schema.accounts).values({
      projectId: project.id,
      platformId: platform.id,
      handle: 'alice',
      role: 'personal',
    });
    await db.insert(schema.campaigns).values({
      projectId: project.id,
      platformId: platform.id,
      name: 'Scout',
      skillSlug: 'reddit-scout',
      config: VALID_SCOUT_PROFILE,
    });
  });

  it('creates a run row and emits a JSON payload with config', async () => {
    const out = cli('run:start --campaign=1');
    const lines = out.trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.runId).toBeGreaterThan(0);
    expect(parsed.data.campaign.name).toBe('Scout');
    expect(parsed.data.accounts[0].handle).toBe('alice');
  });
});

afterAll(async () => {
  await getPool().end();
});
