// #431/#434: an extraction run reads a project's whole active project_sources
// set instead of one source pinned in runs.params.source. This defends the
// three pieces of that model project-extract-start.test.ts and
// project-extract-source-access.test.ts do not cover: an inactive source is
// left out of what the agent sees, a non-tree source's cached read is
// flattened into text (or reported as a gap when nothing has filled it yet),
// and a project with more than one file-tree source refuses to guess which
// one a files/read call means.
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { sql } from 'drizzle-orm';
import { createProjectSource, updateProjectSource } from '@pitchbox/shared/project-sources';
import { SOURCE_CONTENT_MAX_CHARS } from '@pitchbox/shared/project-source-content';
import {
  projectExtractStart,
  projectExtractSources,
  projectExtractListFiles,
} from '../../src/commands/project.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE runs, projects RESTART IDENTITY CASCADE`);
}

async function makeProjectAndRun(orgId: number, slug: string) {
  const db = getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'project_extraction',
      projectId: project.id,
      trigger: 'manual',
      status: 'running',
      params: {},
    })
    .returning();
  return { project, run };
}

describe('project extraction reads the project source set (#431/#434)', () => {
  let orgId: number;

  beforeEach(async () => {
    await reset();
    const [org] = await getDb()
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    orgId = org.id;
  });

  it('start lists every active source and marks tree vs cached-read kinds', async () => {
    const db = getDb();
    const { project, run } = await makeProjectAndRun(orgId, 'p-active');
    const folder = await mkdtemp(join(tmpdir(), 'pbactive-'));
    const folderSource = await createProjectSource(db, orgId, project.id, 'folder', {
      value: folder,
    });
    const websiteSource = await createProjectSource(db, orgId, project.id, 'website', {
      url: 'https://example.com',
    });
    const droppedSource = await createProjectSource(db, orgId, project.id, 'website', {
      url: 'https://gone.example.com',
    });
    await updateProjectSource(db, orgId, droppedSource!.id, { active: false });

    const out = await projectExtractStart(run.id);
    const ids = out.sources.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([folderSource!.id, websiteSource!.id]));
    expect(ids).not.toContain(droppedSource!.id);

    const folderView = out.sources.find((s) => s.id === folderSource!.id)!;
    expect(folderView.readsAsTree).toBe(true);
    const websiteView = out.sources.find((s) => s.id === websiteSource!.id)!;
    expect(websiteView.readsAsTree).toBe(false);
  });

  it('sources flattens a filled cached read, and reports a gap for an unfilled one', async () => {
    const db = getDb();
    const { project, run } = await makeProjectAndRun(orgId, 'p-content');
    const website = await createProjectSource(db, orgId, project.id, 'website', {
      url: 'https://example.com',
    });
    await updateProjectSource(db, orgId, website!.id, {
      output: {
        url: 'https://example.com',
        text: 'We sell rocket-powered staplers.',
        fetchedPageCount: 3,
      },
      fetchedAt: new Date(),
    });
    const unfilled = await createProjectSource(db, orgId, project.id, 'mastodon_account', {
      instanceUrl: 'https://mastodon.example',
      acct: 'ghost',
    });
    await updateProjectSource(db, orgId, unfilled!.id, { fetchError: 'account not found' });

    const out = await projectExtractSources(run.id);
    expect(out.maxCharsPerSource).toBe(SOURCE_CONTENT_MAX_CHARS);

    const websiteView = out.sources.find((s) => s.id === website!.id)!;
    expect(websiteView.content).toContain('rocket-powered staplers');
    expect(websiteView.content).toContain('Crawled 3 page(s)');

    const unfilledView = out.sources.find((s) => s.id === unfilled!.id)!;
    expect(unfilledView.content).toBeNull();
    expect(unfilledView.fetchError).toBe('account not found');
  });

  it('listFiles demands a sourceId with two trees, and reads the right one', async () => {
    const db = getDb();
    const { project, run } = await makeProjectAndRun(orgId, 'p-trees');
    const folderA = await mkdtemp(join(tmpdir(), 'pbtreea-'));
    await writeFile(join(folderA, 'only-in-a.md'), 'a');
    const folderB = await mkdtemp(join(tmpdir(), 'pbtreeb-'));
    await writeFile(join(folderB, 'only-in-b.md'), 'b');
    const sourceA = await createProjectSource(db, orgId, project.id, 'folder', {
      value: folderA,
    });
    const sourceB = await createProjectSource(db, orgId, project.id, 'folder', {
      value: folderB,
    });

    await expect(projectExtractListFiles(run.id)).rejects.toThrow(
      new RegExp(`${sourceA!.id}.*${sourceB!.id}`),
    );

    const listedA = await projectExtractListFiles(run.id, sourceA!.id);
    expect(listedA.files.map((f) => f.path)).toContain('only-in-a.md');
    expect(listedA.files.map((f) => f.path)).not.toContain('only-in-b.md');

    const listedB = await projectExtractListFiles(run.id, sourceB!.id);
    expect(listedB.files.map((f) => f.path)).toContain('only-in-b.md');
    expect(listedB.files.map((f) => f.path)).not.toContain('only-in-a.md');
  });
});

afterAll(async () => {
  await getPool().end();
});
