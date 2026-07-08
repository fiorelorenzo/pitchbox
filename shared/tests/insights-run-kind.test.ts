import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

async function reset() {
  await getDb().execute(sql`TRUNCATE runs, projects RESTART IDENTITY CASCADE`);
}

describe('project_insights run kind', () => {
  beforeEach(reset);

  it('accepts a project_insights run with a project_id', async () => {
    const db = getDb();
    const [proj] = await db.insert(schema.projects).values({ slug: 'pi', name: 'pi' }).returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_insights',
        projectId: proj.id,
        trigger: 'manual',
        status: 'running',
      })
      .returning();
    expect(run.kind).toBe('project_insights');
    expect(run.projectId).toBe(proj.id);
  });

  it('rejects a project_insights run without a project_id', async () => {
    const db = getDb();
    await expect(
      db
        .insert(schema.runs)
        .values({ kind: 'project_insights', trigger: 'manual', status: 'running' }),
    ).rejects.toThrow();
  });
});
