import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, input?: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input,
    cwd: '/Users/lorenzofiore/Progetti/Personale/pitchbox',
  });
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE campaign_recommendations, runs, projects RESTART IDENTITY CASCADE`);
}

describe('project_extraction e2e with recommendations', () => {
  beforeEach(reset);

  it('start → finish writes description + 2 recommendations', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pbrec-'));
    await writeFile(join(folder, 'README.md'), '# Demo product');

    const db = getDb();
    const [project] = await db.insert(schema.projects).values({ slug: 'p', name: 'P' }).returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: folder } },
      })
      .returning();

    const startOut = JSON.parse(
      cli(`project:extract:start --run=${run.id}`).trim().split('\n').at(-1)!,
    );
    expect(Array.isArray(startOut.data.scenarios)).toBe(true);

    const payload = JSON.stringify({
      description: '## Product\n\nDemo.\n',
      recommendations: [
        {
          scenarioSlug: 'reddit-scout',
          name: 'Scout players',
          objective: 'Find players curious about AI GMs.',
        },
        {
          scenarioSlug: 'reddit-commenter',
          name: 'Help in r/rpg',
          objective: 'Reply to people asking about session prep.',
        },
      ],
    });
    const finishOut = JSON.parse(
      cli(`project:extract:finish --run=${run.id}`, payload).trim().split('\n').at(-1)!,
    );
    expect(finishOut.ok).toBe(true);
    expect(finishOut.data.recommendations).toBe(2);

    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(p.description).toContain('Demo.');
    const recs = await db
      .select()
      .from(schema.campaignRecommendations)
      .where(eq(schema.campaignRecommendations.projectId, project.id));
    expect(recs).toHaveLength(2);

    await rm(folder, { recursive: true, force: true });
  });
});

afterAll(async () => {
  await getPool().end();
});
