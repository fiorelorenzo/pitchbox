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
    cwd: '/Users/lorenzofiore/Progetti/Personale/pitchbox',
  });
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE runs, projects RESTART IDENTITY CASCADE`);
}

describe('pitchbox project:extract:start', () => {
  let runId: number;
  let projectId: number;
  let folder: string;

  beforeEach(async () => {
    await reset();
    const db = getDb();
    folder = await mkdtemp(join(tmpdir(), 'pbfolder-'));
    await writeFile(join(folder, 'README.md'), '# Test');
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
        params: { source: { kind: 'folder', value: folder } },
      })
      .returning();
    runId = run.id;
  });

  it('returns sourcePath, scaffoldTemplate, currentDescription, projectId', async () => {
    const out = cli(`project:extract:start --run=${runId}`);
    const last = out.trim().split('\n').at(-1)!;
    const parsed = JSON.parse(last);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.projectId).toBe(projectId);
    expect(parsed.data.sourcePath).toBe(folder);
    expect(parsed.data.scaffoldTemplate).toMatch(/## Product/);
    expect(parsed.data.currentDescription).toBe('');
  });

  it('rejects a folder path that does not exist', async () => {
    const db = getDb();
    await db
      .update(schema.runs)
      .set({ params: { source: { kind: 'folder', value: '/nope/never' } } })
      .where(eq(schema.runs.id, runId));
    expect(() => cli(`project:extract:start --run=${runId}`)).toThrow();
  });
});

afterAll(async () => {
  await getPool().end();
});
