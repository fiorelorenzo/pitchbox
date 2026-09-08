// #431: an extraction run's source is now recorded as a `project_sources`
// row, so it survives past this one run and is readable per project -
// instead of living only in `runs.params`, which callers clear once the
// run's temp dir is cleaned up (see `recordExtractionSource` in
// cli/src/commands/project.ts).
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { listProjectSources } from '@pitchbox/shared/project-sources';
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

async function setupProjectAndRun(folder: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p1', name: 'P1' })
    .returning();
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
  return { orgId: org.id, projectId: project.id, runId: run.id };
}

describe('project:extract:start persists the run source', () => {
  beforeEach(reset);

  it('is readable per project after the run, through listProjectSources', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pbsrc-'));
    await writeFile(join(folder, 'README.md'), '# Demo');
    const { orgId, projectId, runId } = await setupProjectAndRun(folder);

    const out = cli(`project:extract:start --run=${runId}`);
    expect(JSON.parse(out.trim().split('\n').at(-1)!).ok).toBe(true);

    const db = getDb();
    const sources = await listProjectSources(db, orgId, projectId);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'folder', config: { value: folder }, active: true });
    expect(sources[0].fetchedAt).not.toBeNull();
    expect(sources[0].fetchError).toBeNull();
  });

  it('refreshes the same source instead of duplicating it when re-run from the same folder', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pbsrc-'));
    await writeFile(join(folder, 'README.md'), '# Demo');
    const { orgId, projectId, runId: firstRunId } = await setupProjectAndRun(folder);
    cli(`project:extract:start --run=${firstRunId}`);

    const db = getDb();
    const [firstFetch] = await listProjectSources(db, orgId, projectId);

    // A second extraction run against the exact same folder.
    const [run2] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: folder } },
      })
      .returning();
    cli(`project:extract:start --run=${run2.id}`);

    const sources = await listProjectSources(db, orgId, projectId);
    expect(sources).toHaveLength(1); // refreshed in place, not duplicated
    expect(sources[0].id).toBe(firstFetch.id);
  });

  it('adds a second source when a later run uses a different folder', async () => {
    const folderA = await mkdtemp(join(tmpdir(), 'pbsrc-a-'));
    await writeFile(join(folderA, 'README.md'), '# A');
    const { orgId, projectId, runId: runA } = await setupProjectAndRun(folderA);
    cli(`project:extract:start --run=${runA}`);

    const folderB = await mkdtemp(join(tmpdir(), 'pbsrc-b-'));
    await writeFile(join(folderB, 'README.md'), '# B');
    const db = getDb();
    const [runB] = await db
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId,
        trigger: 'manual',
        status: 'running',
        params: { source: { kind: 'folder', value: folderB } },
      })
      .returning();
    cli(`project:extract:start --run=${runB.id}`);

    const sources = await listProjectSources(db, orgId, projectId);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => (s.config as { value: string }).value).sort()).toEqual(
      [folderA, folderB].sort(),
    );
  });
});

afterAll(async () => {
  await getPool().end();
});
