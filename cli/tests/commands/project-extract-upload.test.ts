import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { eq, sql } from 'drizzle-orm';

function cli(args: string, input?: string): string {
  return execSync(`npm -s run -w @pitchbox/cli dev -- ${args}`, {
    encoding: 'utf8',
    input,
    cwd: '/Users/lorenzofiore/Progetti/Personale/pitchbox',
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

  it('start returns sourcePath; finish writes description and removes the temp dir', async () => {
    const upload = await mkdtemp(join(tmpdir(), 'pitchbox-upload-'));
    await writeFile(join(upload, 'README.md'), '# Demo\nA demo product.\n');

    const db = getDb();
    const [project] = await db
      .insert(schema.projects)
      .values({ slug: 'p', name: 'P' })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'upload', value: upload } },
      })
      .returning();

    const startOut = JSON.parse(
      cli(`project:extract:start --run=${run.id}`).trim().split('\n').at(-1)!,
    );
    expect(startOut.ok).toBe(true);
    expect(startOut.data.sourcePath).toBe(upload);

    const md = `## Product\n\nDemo.\n`;
    const finishOut = JSON.parse(
      cli(`project:extract:finish --run=${run.id}`, md).trim().split('\n').at(-1)!,
    );
    expect(finishOut.ok).toBe(true);

    const [p] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(p.description).toBe(md);

    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, run.id));
    expect(r.status).toBe('success');

    // Most important assertion of this test: the temp dir is gone.
    expect(await exists(upload)).toBe(false);
  });
});

afterAll(async () => {
  await getPool().end();
});
