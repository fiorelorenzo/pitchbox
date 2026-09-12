// LOR-320: a description run whose repository source is private. Cloning is
// the only path that reads the tree, so with no credential the run dies on
// authentication and the project never gets a description. What is defended
// here is the wiring: the token is minted for the run's project's
// organization and for the URL's own owner, and a repository that is not on
// github.com is still cloned anonymously.
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { createProjectSource } from '@pitchbox/shared/project-sources';
import { sql } from 'drizzle-orm';

const shallowClone = vi.hoisted(() => vi.fn(async () => {}));
const installationTokenForOwner = vi.hoisted(() =>
  vi.fn(async () => ({ token: 'ghs_installation', installationId: 160288218 })),
);

vi.mock('../../src/lib/git-clone.js', () => ({ shallowClone }));
vi.mock('@pitchbox/shared/github-app', () => ({ installationTokenForOwner }));

import { projectExtractListFiles } from '../../src/commands/project.js';

async function seedRun(repoUrl: string) {
  const db = getDb();
  // Not `RESTART IDENTITY`: `resolveTreeSourcePath` caches a clone per
  // `run.id:source.id`, so reusing the ids would make the second test hit
  // the first one's cached clone and call nothing.
  await db.execute(sql`TRUNCATE runs, projects CASCADE`);
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p1', name: 'P1' })
    .returning();
  const source = await createProjectSource(db, org.id, project.id, 'git', { value: repoUrl });
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
  return { orgId: org.id, runId: run.id };
}

beforeEach(() => {
  shallowClone.mockClear();
  installationTokenForOwner.mockClear();
});

afterAll(async () => {
  await getPool().end();
});

describe('cloning a private repository for a description run', () => {
  it("clones with the installation token of the run's organization", async () => {
    const { orgId, runId } = await seedRun('https://github.com/fiorelorenzo/sazio.git');

    // The clone is mocked, so the listing of a directory that was never
    // created is expected to fail - what this asserts is the call it made on
    // the way there.
    await projectExtractListFiles(runId).catch(() => undefined);

    expect(installationTokenForOwner).toHaveBeenCalledWith(
      expect.anything(),
      orgId,
      'fiorelorenzo',
    );
    expect(shallowClone).toHaveBeenCalledWith(
      'https://github.com/fiorelorenzo/sazio.git',
      expect.stringContaining(`/tmp/pitchbox-extract-${runId}-`),
      { credential: { username: 'x-access-token', token: 'ghs_installation' } },
    );
  });

  it('clones anonymously when the URL is not a github.com repository', async () => {
    const { runId } = await seedRun('https://gitlab.com/acme/widget.git');

    await projectExtractListFiles(runId).catch(() => undefined);

    expect(installationTokenForOwner).not.toHaveBeenCalled();
    expect(shallowClone).toHaveBeenCalledWith(
      'https://gitlab.com/acme/widget.git',
      expect.stringContaining(`/tmp/pitchbox-extract-${runId}-`),
      { credential: null },
    );
  });
});
