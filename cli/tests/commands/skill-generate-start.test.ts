import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string): string {
  return execSync(`npm -s run -w @pitchbox/cli dev -- ${args}`, {
    encoding: 'utf8',
    cwd: '/Users/lorenzofiore/Progetti/Personale/pitchbox',
  });
}

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE runs, campaigns, projects, accounts RESTART IDENTITY CASCADE`,
  );
}

describe('pitchbox skill:generate:start', () => {
  let runId: number;
  let campaignId: number;
  let projectId: number;

  beforeEach(async () => {
    await reset();
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'p', name: 'P', description: '# Hello\nA test project.' })
      .returning();
    projectId = project.id;
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId,
        platformId: platform.id,
        name: 'C1',
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
        params: { scenario: 'reddit-scout', objective: 'Find RPG players' },
      })
      .returning();
    runId = run.id;
  });

  it('returns campaign + project + scenario + schema description', () => {
    const out = cli(`skill:generate:start --run=${runId}`);
    const last = out.trim().split('\n').at(-1)!;
    const parsed = JSON.parse(last);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.campaignId).toBe(campaignId);
    expect(parsed.data.scenario).toBe('reddit-scout');
    expect(parsed.data.objective).toBe('Find RPG players');
    expect(parsed.data.project.description).toContain('test project');
    expect(parsed.data.schemaPromptDescription).toContain('targetSubreddits');
    expect(parsed.data.existingConfig).toBeDefined();
  });
});

afterAll(async () => {
  await getPool().end();
});
