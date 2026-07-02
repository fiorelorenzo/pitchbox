import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cliWithStdin(args: string, input: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    input,
    cwd: process.cwd(),
  });
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE runs, projects RESTART IDENTITY CASCADE`);
}

describe('pitchbox project:extract:finish', () => {
  let runId: number;
  let projectId: number;

  beforeEach(async () => {
    await reset();
    const db = getDb();
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'p1', name: 'P1' })
      .returning();
    projectId = project.id;
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: '/tmp/x' } },
      })
      .returning();
    runId = run.id;
  });

  it('writes the markdown to projects.description and marks the run success', async () => {
    const md = '## Product\n\nA test product.\n';
    const out = cliWithStdin(`project:extract:finish --run=${runId}`, md);
    const parsed = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(parsed.ok).toBe(true);
    const db = getDb();
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(p.description).toBe(md);
    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(r.status).toBe('success');
    expect(r.finishedAt).not.toBeNull();
  });

  it('rejects empty markdown', () => {
    expect(() => cliWithStdin(`project:extract:finish --run=${runId}`, '   ')).toThrow();
  });
});

afterAll(async () => {
  await getPool().end();
});
