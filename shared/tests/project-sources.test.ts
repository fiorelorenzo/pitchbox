// Exercises shared/src/project-sources.ts: create/list/update/delete for a
// project's set of sources (#431), organization scoping through the owning
// project (never a column of its own - see project-sources.ts), and the
// 0018 migration's data backfill from the old project-scoped github_sources
// rows.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import {
  createProjectSource,
  deleteProjectSource,
  listProjectSources,
  updateProjectSource,
} from '../src/project-sources.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    // Cascades to projects, then to project_sources (onDelete: 'cascade' on
    // both hops in schema.ts).
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function setupOrgAndProject() {
  const db = getDb();
  const slug = `project-sources-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

describe('createProjectSource / listProjectSources', () => {
  it('creates sources and lists them for their project, oldest first', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    const first = await createProjectSource(db, orgId, projectId, 'folder', { value: '/tmp/a' });
    const second = await createProjectSource(db, orgId, projectId, 'website', {
      url: 'https://example.com',
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const listed = await listProjectSources(db, orgId, projectId);
    expect(listed.map((s) => s.id)).toEqual([first!.id, second!.id]);
    expect(listed[0]).toMatchObject({ kind: 'folder', config: { value: '/tmp/a' }, active: true });
    expect(listed[1]).toMatchObject({ kind: 'website', config: { url: 'https://example.com' } });
  });

  it('does not create a source for, or list an existing source of, a project in a different organization', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();

    // A real source exists under the project's own org, so a wrong-org list
    // returning [] proves isolation rather than proving "nothing exists yet".
    const own = await createProjectSource(db, orgId, projectId, 'folder', { value: '/tmp/a' });
    expect(own).not.toBeNull();

    const created = await createProjectSource(db, otherOrgId, projectId, 'folder', {
      value: '/tmp/b',
    });
    expect(created).toBeNull();
    expect(await listProjectSources(db, otherOrgId, projectId)).toEqual([]);
    expect(await listProjectSources(db, orgId, projectId)).toHaveLength(1);
  });
});

describe('updateProjectSource', () => {
  it('updates config, output and fetch state', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'website', {
      url: 'https://example.com',
    });

    const updated = await updateProjectSource(db, orgId, created!.id, {
      output: { text: 'hello' },
      fetchedAt: new Date('2026-01-01T00:00:00Z'),
      fetchError: null,
    });
    expect(updated?.output).toEqual({ text: 'hello' });
    expect(updated?.fetchedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(updated?.fetchError).toBeNull();
  });

  it('returns null for a source id that does not exist', async () => {
    const { orgId } = await setupOrgAndProject();
    const db = getDb();
    expect(await updateProjectSource(db, orgId, 999_999, { active: false })).toBeNull();
  });

  it('does not update a source belonging to a project in a different organization', async () => {
    const { orgId: orgA, projectId } = await setupOrgAndProject();
    const { orgId: orgB } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgA, projectId, 'folder', { value: '/tmp/a' });

    const updated = await updateProjectSource(db, orgB, created!.id, { active: false });
    expect(updated).toBeNull();

    const [row] = await listProjectSources(db, orgA, projectId);
    expect(row.active).toBe(true);
  });
});

describe('deleteProjectSource', () => {
  it('deletes a source scoped to its organization', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'folder', { value: '/tmp/a' });

    expect(await deleteProjectSource(db, orgId, created!.id)).toBe(true);
    expect(await listProjectSources(db, orgId, projectId)).toEqual([]);
  });

  it('does not delete or leak a source belonging to a different organization', async () => {
    const { orgId: orgA, projectId } = await setupOrgAndProject();
    const { orgId: orgB } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgA, projectId, 'folder', { value: '/tmp/a' });

    expect(await deleteProjectSource(db, orgB, created!.id)).toBe(false);
    expect(await listProjectSources(db, orgA, projectId)).toHaveLength(1);
  });
});

describe('0018_project_sources migration backfill', () => {
  it('turns a project-scoped github_sources row into a project_sources row of kind github', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();

    // Replays the migration's own INSERT...SELECT against a scratch table
    // shaped like the pre-#431 github_sources (project_id + owner/repo/url +
    // cached read), so this fails the moment the real backfill statement in
    // the shipped .sql file drifts from what this test exercises.
    const migrationPath = fileURLToPath(
      new URL('../src/db/migrations/0018_project_sources.sql', import.meta.url),
    );
    const migrationSql = await readFile(migrationPath, 'utf8');
    const backfillChunk = migrationSql
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .find((chunk) => chunk.includes('INSERT INTO "project_sources"'));
    if (!backfillChunk) {
      throw new Error('0018_project_sources.sql no longer carries its data backfill INSERT');
    }

    const scratchTable = `test_github_sources_old_shape_${randomUUID().replace(/-/g, '')}`;
    await db.execute(
      sql.raw(`
        CREATE TABLE "${scratchTable}" (
          project_id integer,
          owner text NOT NULL,
          repo text NOT NULL,
          url text NOT NULL,
          description text,
          primary_language text,
          readme_excerpt text,
          recent_commits jsonb NOT NULL DEFAULT '[]'::jsonb,
          active boolean NOT NULL DEFAULT true,
          fetched_at timestamptz,
          fetch_error text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `),
    );
    try {
      await db.execute(
        sql.raw(`
          INSERT INTO "${scratchTable}"
            (project_id, owner, repo, url, description, primary_language, readme_excerpt, recent_commits, active, fetched_at, fetch_error)
          VALUES (
            ${projectId}, 'acme', 'widget', 'https://github.com/acme/widget',
            'The widget that does the thing', 'TypeScript', 'Widget does the thing well.',
            '[{"sha":"abc123","message":"init","committedAt":"2026-01-01T00:00:00Z"}]'::jsonb,
            true, now(), NULL
          )
        `),
      );

      const replayed = backfillChunk.replace('FROM "github_sources"', `FROM "${scratchTable}"`);
      expect(replayed).not.toBe(backfillChunk); // the substitution must have matched something
      await db.execute(sql.raw(replayed));

      const rows = await listProjectSources(db, orgId, projectId);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('github');
      expect(rows[0].config).toEqual({
        owner: 'acme',
        repo: 'widget',
        url: 'https://github.com/acme/widget',
      });
      expect(rows[0].output).toMatchObject({
        description: 'The widget that does the thing',
        primaryLanguage: 'TypeScript',
        readmeExcerpt: 'Widget does the thing well.',
      });
      expect(rows[0].active).toBe(true);
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${scratchTable}"`));
    }
  });
});
