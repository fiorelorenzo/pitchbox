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
    cwd: process.cwd(),
  });
}

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE runs, projects RESTART IDENTITY CASCADE`);
}

describe('project_extraction end-to-end (no real agent)', () => {
  beforeEach(reset);

  it('start → finish updates description and marks run success', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pbe2e-'));
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
    expect(startOut.ok).toBe(true);
    expect(startOut.data.sourcePath).toBe(folder);

    const md = `## Product\n\nDemo product.\n\n## Target audience\n\nDevs.\n`;
    const finishOut = JSON.parse(
      cli(`project:extract:finish --run=${run.id}`, md).trim().split('\n').at(-1)!,
    );
    expect(finishOut.ok).toBe(true);

    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(p.description).toBe(md);
    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, run.id));
    expect(r.status).toBe('success');

    await rm(folder, { recursive: true, force: true });
  });
});

afterAll(async () => {
  await getPool().end();
});
