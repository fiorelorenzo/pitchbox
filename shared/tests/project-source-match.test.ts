// Exercises shared/src/project-source-match.ts: matching and filling a
// pending linkedin_post/linkedin_profile project source against a real
// identifier (#436, spike #435's "Plane 3").
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { createProjectSource, getProjectSource } from '../src/project-sources.js';
import {
  findPendingProjectSourceMatch,
  fillProjectSourceFromCapture,
} from '../src/project-source-match.js';

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
  const slug = `project-source-match-test-${randomUUID()}`;
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  createdOrgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'p', name: 'P' })
    .returning();
  return { orgId: org.id, projectId: project.id };
}

describe('findPendingProjectSourceMatch', () => {
  it('finds a pending source by kind and identifier', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const match = await findPendingProjectSourceMatch(
      db,
      orgId,
      'linkedin_post',
      'urn:li:activity:123',
    );
    expect(match).toEqual({ id: created!.id, projectId });
  });

  it('never matches a source that already has output - a refresh needs a second visit', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });
    await getDb()
      .update(schema.projectSources)
      .set({ output: { text: 'already captured' }, fetchedAt: new Date() })
      .where(eq(schema.projectSources.id, created!.id));

    const match = await findPendingProjectSourceMatch(
      db,
      orgId,
      'linkedin_post',
      'urn:li:activity:123',
    );
    expect(match).toBeNull();
  });

  it('never matches a source scoped to a different organization', async () => {
    const { orgId: ownerOrgId, projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();
    await createProjectSource(db, ownerOrgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const match = await findPendingProjectSourceMatch(
      db,
      otherOrgId,
      'linkedin_post',
      'urn:li:activity:123',
    );
    expect(match).toBeNull();
  });

  it('never matches a different kind carrying the same identifier text', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    await createProjectSource(db, orgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'shared-slug',
    });

    const match = await findPendingProjectSourceMatch(db, orgId, 'linkedin_profile', 'shared-slug');
    expect(match).toBeNull();
  });
});

describe('fillProjectSourceFromCapture', () => {
  it('fills a pending source and clears any prior fetchError', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const filled = await fillProjectSourceFromCapture(
      db,
      orgId,
      created!.id,
      'linkedin_post',
      'urn:li:activity:123',
      { urn: 'urn:li:activity:123', text: 'What we shipped this week.' },
    );
    expect(filled).not.toBeNull();
    expect(filled!.output).toEqual({
      urn: 'urn:li:activity:123',
      text: 'What we shipped this week.',
    });
    expect(filled!.fetchedAt).not.toBeNull();
    expect(filled!.fetchError).toBeNull();

    const reloaded = await getProjectSource(db, orgId, created!.id);
    expect(reloaded!.output).toEqual({
      urn: 'urn:li:activity:123',
      text: 'What we shipped this week.',
    });
  });

  it('refuses a fill whose identifier no longer matches the stored one', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const filled = await fillProjectSourceFromCapture(
      db,
      orgId,
      created!.id,
      'linkedin_post',
      'urn:li:activity:999',
      { urn: 'urn:li:activity:999', text: 'wrong post' },
    );
    expect(filled).toBeNull();
    const reloaded = await getProjectSource(db, orgId, created!.id);
    expect(reloaded!.output).toBeNull();
  });

  it('refuses a fill for a source that is already filled - the row must be reset to pending first', async () => {
    const { orgId, projectId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, orgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });
    await fillProjectSourceFromCapture(
      db,
      orgId,
      created!.id,
      'linkedin_post',
      'urn:li:activity:123',
      {
        urn: 'urn:li:activity:123',
        text: 'first capture',
      },
    );

    const secondFill = await fillProjectSourceFromCapture(
      db,
      orgId,
      created!.id,
      'linkedin_post',
      'urn:li:activity:123',
      { urn: 'urn:li:activity:123', text: 'second capture' },
    );
    expect(secondFill).toBeNull();
    const reloaded = await getProjectSource(db, orgId, created!.id);
    expect(reloaded!.output).toEqual({ urn: 'urn:li:activity:123', text: 'first capture' });
  });

  it('refuses a fill for a source belonging to a different organization', async () => {
    const { orgId: ownerOrgId, projectId } = await setupOrgAndProject();
    const { orgId: otherOrgId } = await setupOrgAndProject();
    const db = getDb();
    const created = await createProjectSource(db, ownerOrgId, projectId, 'linkedin_post', {
      value: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
      identifier: 'urn:li:activity:123',
    });

    const filled = await fillProjectSourceFromCapture(
      db,
      otherOrgId,
      created!.id,
      'linkedin_post',
      'urn:li:activity:123',
      { urn: 'urn:li:activity:123', text: 'stolen capture' },
    );
    expect(filled).toBeNull();
  });
});
