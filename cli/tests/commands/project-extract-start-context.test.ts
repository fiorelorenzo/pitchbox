import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE runs, campaigns, projects RESTART IDENTITY CASCADE`);
}

describe('pitchbox project:extract:start - recommendations context', () => {
  let runId: number;
  let projectId: number;
  let folder: string;

  beforeEach(async () => {
    await reset();
    const db = getDb();
    folder = await mkdtemp(join(tmpdir(), 'pbcontext-'));
    await writeFile(join(folder, 'README.md'), '# demo');
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'p', name: 'P', description: '# demo' })
      .returning();
    projectId = project.id;

    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId,
        platformId: platform.id,
        name: 'Existing scout',
        skillSlug: 'reddit-scout',
        status: 'active',
        config: {},
      })
      .returning();
    await db.insert(schema.runs).values({
      kind: 'campaign_skill_generation',
      campaignId: campaign.id,
      trigger: 'manual',
      status: 'success',
      params: { scenario: 'reddit-scout', objective: 'find rpg players' },
    });

    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: folder } },
      })
      .returning();
    runId = run.id;
  });

  it('returns scenarios and existingCampaigns', () => {
    const out = cli(`project:extract:start --run=${runId}`);
    const parsed = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.scenarios)).toBe(true);
    expect(parsed.data.scenarios.map((s: { slug: string }) => s.slug)).toEqual(
      expect.arrayContaining(['reddit-scout', 'reddit-commenter']),
    );
    expect(parsed.data.existingCampaigns).toHaveLength(1);
    expect(parsed.data.existingCampaigns[0]).toMatchObject({
      name: 'Existing scout',
      scenarioSlug: 'reddit-scout',
      objective: 'find rpg players',
    });
  });

  it('returns empty objective for campaigns without skill_generation history', async () => {
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    await db.insert(schema.campaigns).values({
      projectId,
      platformId: platform.id,
      name: 'Seeded',
      skillSlug: 'reddit-commenter',
      status: 'active',
      config: {},
    });
    const out = cli(`project:extract:start --run=${runId}`);
    const parsed = JSON.parse(out.trim().split('\n').at(-1)!);
    const seeded = parsed.data.existingCampaigns.find((c: { name: string }) => c.name === 'Seeded');
    expect(seeded.objective).toBe('');
  });
});

afterAll(async () => {
  await getPool().end();
});
