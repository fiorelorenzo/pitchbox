// Exercises shared/src/project-source-sync.ts: the per-kind fetch dispatcher
// behind a project source's "re-sync" (#432). `github` is the one kind with
// a real fetcher today; `website`/`linkedin_*` (not implemented yet - #433,
// #435) and `folder`/`git`/`upload` (populated by running an extraction, not
// by syncing) must each come back with a human-readable fetch_error instead
// of throwing, so an unimplemented kind renders as a source you can add and
// see rather than a crash.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { createProjectSource, getProjectSource } from '../src/project-sources.js';
import { syncProjectSource } from '../src/project-source-sync.js';
import type { GithubFetch } from '../src/github-sources.js';

const createdOrgIds: number[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
});

async function setupOrgAndProject() {
  const db = getDb();
  const slug = `project-source-sync-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

const REPO_JSON = { description: 'A test repo', language: 'TypeScript' };
const README_JSON = (markdown: string) => ({
  content: Buffer.from(markdown, 'utf8').toString('base64'),
  encoding: 'base64',
});

function successfulFetch(readme = 'What this project does.'): GithubFetch {
  return async (url: string) => {
    if (url.endsWith('/readme')) return fakeResponse(200, README_JSON(readme));
    return fakeResponse(200, REPO_JSON);
  };
}

describe('syncProjectSource: github', () => {
  it('a successful fetch stores output and clears fetch_error', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'github', {
      value: 'https://github.com/acme/widget',
    });
    const result = await syncProjectSource(db, orgId, created!.id, {
      fetchImpl: successfulFetch(),
    });
    expect(result?.ok).toBe(true);
    expect(result?.source.fetchError).toBeNull();
    expect(result?.source.fetchedAt).not.toBeNull();
    expect(result?.source.output).toMatchObject({
      description: 'A test repo',
      primaryLanguage: 'TypeScript',
      readmeExcerpt: 'What this project does.',
    });
  });

  it('a 404 sets a fetch_error explaining the repo was not found, in words', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'github', {
      value: 'https://github.com/acme/missing',
    });
    const fetchImpl: GithubFetch = async () => fakeResponse(404, {});
    const result = await syncProjectSource(db, orgId, created!.id, { fetchImpl });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toMatch(/not found/i);
  });

  it('an unparseable value sets a fetch_error instead of throwing', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'github', {
      value: 'not a github url at all!!',
    });
    const result = await syncProjectSource(db, orgId, created!.id, {
      fetchImpl: successfulFetch(),
    });
    expect(result?.ok).toBe(false);
    expect(result?.source.fetchError).toBeTruthy();
  });
});

describe('syncProjectSource: kinds with no fetcher yet', () => {
  it.each(['website', 'linkedin_company', 'linkedin_profile', 'linkedin_post'] as const)(
    '%s sets a fetch_error naming the kind, not a crash',
    async (kind) => {
      const { orgId, projectId } = await setupOrgAndProject();
      const db = getDb();
      const created = await createProjectSource(db, orgId, projectId, kind, {
        value: 'https://example.com/whatever',
      });
      const result = await syncProjectSource(db, orgId, created!.id);
      expect(result?.ok).toBe(false);
      expect(result?.source.fetchError).toContain(kind);
      expect(result?.source.fetchedAt).not.toBeNull();
    },
  );
});

describe('syncProjectSource: extraction-only kinds', () => {
  it.each(['folder', 'git', 'upload'] as const)(
    '%s sets a fetch_error explaining it needs an extraction run',
    async (kind) => {
      const { orgId, projectId } = await setupOrgAndProject();
      const db = getDb();
      const created = await createProjectSource(db, orgId, projectId, kind, { value: '/tmp/x' });
      const result = await syncProjectSource(db, orgId, created!.id);
      expect(result?.ok).toBe(false);
      expect(result?.source.fetchError).toMatch(/extraction/i);
    },
  );
});

describe('syncProjectSource: organization scoping', () => {
  it('returns null for a source belonging to a different organization', async () => {
    const { orgId: ownerOrgId, projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, ownerOrgId, projectId, 'github', {
      value: 'https://github.com/acme/widget',
    });
    const result = await syncProjectSource(db, otherOrgId, created!.id);
    expect(result).toBeNull();
    // Nothing about the row moved - a probe from the wrong org learns nothing.
    const reloaded = await getProjectSource(db, ownerOrgId, created!.id);
    expect(reloaded?.fetchedAt).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    const { orgId } = await setupOrgAndProject();
    const result = await syncProjectSource(getDb(), orgId, 9_999_999);
    expect(result).toBeNull();
  });
});
