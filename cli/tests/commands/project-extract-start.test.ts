import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { createProjectSource } from '@pitchbox/shared/project-sources';
import { sql } from 'drizzle-orm';

function cli(args: string): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    cwd: process.cwd(),
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
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p1', name: 'P1' })
      .returning();
    projectId = project.id;
    const source = await createProjectSource(db, org.id, projectId, 'folder', { value: folder });
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId,
        trigger: 'manual',
        status: 'running',
        params: { sourceIds: [source!.id] },
      })
      .returning();
    runId = run.id;
  });

  it('returns the project source, scaffoldTemplate, currentDescription, projectId', async () => {
    const out = cli(`project:extract:start --run=${runId}`);
    const last = out.trim().split('\n').at(-1)!;
    const parsed = JSON.parse(last);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.projectId).toBe(projectId);
    expect(parsed.data.sources).toHaveLength(1);
    expect(parsed.data.sources[0]).toMatchObject({
      kind: 'folder',
      label: folder,
      readsAsTree: true,
      hasContent: false,
    });
    expect(parsed.data.scaffoldTemplate).toMatch(/## Product/);
    expect(parsed.data.currentDescription).toBe('');
  });
});

afterAll(async () => {
  await getPool().end();
});
