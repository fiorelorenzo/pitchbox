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

const VALID_REC = {
  scenarioSlug: 'reddit-scout',
  name: 'RPG launch',
  objective: 'Find players curious about AI GMs',
};

async function reset() {
  const db = getDb();
  await db.execute(
    sql`TRUNCATE campaign_recommendations, runs, campaigns, projects RESTART IDENTITY CASCADE`,
  );
}

async function setup() {
  const db = getDb();
  const [project] = await db.insert(schema.projects).values({ slug: 'p', name: 'P' }).returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'project_extraction',
      projectId: project.id,
      trigger: 'manual',
      status: 'running',
      params: { source: { kind: 'folder', value: '/tmp/x' } },
    })
    .returning();
  return { project, run };
}

describe('pitchbox project:extract:finish — recommendations payload', () => {
  beforeEach(reset);

  it('accepts JSON shape with description + recommendations', async () => {
    const { project, run } = await setup();
    const payload = {
      description: '## Product\n\nDemo.\n',
      recommendations: [VALID_REC, { ...VALID_REC, name: 'Second' }],
    };
    const out = cliWithStdin(`project:extract:finish --run=${run.id}`, JSON.stringify(payload));
    expect(JSON.parse(out.trim().split('\n').at(-1)!).ok).toBe(true);
    const db = getDb();
    const recs = await db
      .select()
      .from(schema.campaignRecommendations)
      .where(eq(schema.campaignRecommendations.projectId, project.id));
    expect(recs).toHaveLength(2);
  });

  it('replaces previous recommendations on re-extract', async () => {
    const { project, run } = await setup();
    cliWithStdin(
      `project:extract:finish --run=${run.id}`,
      JSON.stringify({ description: '## D', recommendations: [VALID_REC, VALID_REC] }),
    );
    const db = getDb();
    const [run2] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: '/tmp/x' } },
      })
      .returning();
    cliWithStdin(
      `project:extract:finish --run=${run2.id}`,
      JSON.stringify({ description: '## D2', recommendations: [VALID_REC] }),
    );
    const recs = await db
      .select()
      .from(schema.campaignRecommendations)
      .where(eq(schema.campaignRecommendations.projectId, project.id));
    expect(recs).toHaveLength(1);
  });

  it('drops invalid items, keeps valid ones', async () => {
    const { project, run } = await setup();
    const payload = {
      description: '## D',
      recommendations: [VALID_REC, { scenarioSlug: 'unknown', name: 'x', objective: 'y' }],
    };
    cliWithStdin(`project:extract:finish --run=${run.id}`, JSON.stringify(payload));
    const db = getDb();
    const recs = await db
      .select()
      .from(schema.campaignRecommendations)
      .where(eq(schema.campaignRecommendations.projectId, project.id));
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe('RPG launch');
  });

  it('caps at 10 items', async () => {
    const { project, run } = await setup();
    const payload = {
      description: '## D',
      recommendations: Array.from({ length: 12 }, (_, i) => ({
        ...VALID_REC,
        name: `Item ${i}`,
      })),
    };
    cliWithStdin(`project:extract:finish --run=${run.id}`, JSON.stringify(payload));
    const db = getDb();
    const recs = await db
      .select()
      .from(schema.campaignRecommendations)
      .where(eq(schema.campaignRecommendations.projectId, project.id));
    expect(recs).toHaveLength(10);
  });

  it('legacy raw-string payload still works (description only)', async () => {
    const { project, run } = await setup();
    cliWithStdin(`project:extract:finish --run=${run.id}`, '## Product\n\nDemo.\n');
    const db = getDb();
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(p.description).toBe('## Product\n\nDemo.\n');
    const recs = await db
      .select()
      .from(schema.campaignRecommendations)
      .where(eq(schema.campaignRecommendations.projectId, project.id));
    expect(recs).toHaveLength(0);
  });
});

afterAll(async () => {
  await getPool().end();
});
