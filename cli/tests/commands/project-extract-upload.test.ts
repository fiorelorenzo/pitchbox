import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { createProjectSource } from '@pitchbox/shared/project-sources';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, input?: string): string {
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('project_extraction with kind=upload', () => {
  beforeEach(reset);

  it('start lists the upload source; finish writes the description and leaves the upload directory in place', async () => {
    const upload = await mkdtemp(join(tmpdir(), 'pitchbox-upload-'));
    await writeFile(join(upload, 'README.md'), '# Demo\nA demo product.\n');

    const db = getDb();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p', name: 'P' })
      .returning();
    const source = await createProjectSource(db, org.id, project.id, 'upload', { value: upload });
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: { sourceIds: [source!.id] },
      })
      .returning();

    const startOut = JSON.parse(
      cli(`project:extract:start --run=${run.id}`).trim().split('\n').at(-1)!,
    );
    expect(startOut.ok).toBe(true);
    expect(startOut.data.sources).toHaveLength(1);
    expect(startOut.data.sources[0]).toMatchObject({ kind: 'upload', label: upload });

    const md = `## Product\n\nDemo.\n`;
    const finishOut = JSON.parse(
      cli(`project:extract:finish --run=${run.id}`, md).trim().split('\n').at(-1)!,
    );
    expect(finishOut.ok).toBe(true);

    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(p.description).toBe(md);

    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, run.id));
    expect(r.status).toBe('success');

    // Most important assertion of this test: an upload source's directory
    // is the content of a project_sources row that outlives this run, so
    // finish must not delete it (unlike a `git` clone's scratch directory).
    expect(await exists(upload)).toBe(true);
  });
});

afterAll(async () => {
  await getPool().end();
});
