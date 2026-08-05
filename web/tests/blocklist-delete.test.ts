import { describe, expect, it, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { DELETE } from '../src/routes/api/blocklist/[id]/+server.js';

// #229: the blocklist "remove" trash button was a single click with no
// confirmation. The fix only touches the client (an AlertDialog gates the
// click before the fetch fires); the server never had a confirmation step to
// begin with, and none was added. This test locks down that the DELETE
// endpoint's actual contract - auth, tenant isolation for project-scoped
// rows, and requireRole('admin') - is exactly what it was before, so the new
// dialog does not silently become the only thing standing between a client
// and the delete.
async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE blocklist, projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrgWithProject(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `${slug}-proj`,
      name: `${slug} project`,
      defaultAgentRunner: 'claude-code',
    })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  return { orgId: org.id, projectId: project.id, platformId: platform.id };
}

async function addEntry(platformId: number, projectId: number | null, value: string) {
  const db = getDb();
  const [row] = await db
    .insert(schema.blocklist)
    .values({
      platformId,
      kind: 'user',
      value,
      scope: projectId ? 'project' : 'global',
      projectId,
    })
    .returning();
  return row;
}

function deleteEvent(id: number, locals: Record<string, unknown>): RequestEvent {
  return {
    locals,
    params: { id: String(id) },
  } as unknown as RequestEvent;
}

async function exists(id: number): Promise<boolean> {
  const [row] = await getDb().select().from(schema.blocklist).where(eq(schema.blocklist.id, id));
  return row !== undefined;
}

describe('DELETE /api/blocklist/[id]', () => {
  beforeEach(reset);

  it('rejects a member with 403 and leaves the entry in place', async () => {
    const a = await seedOrgWithProject('bl-member');
    const entry = await addEntry(a.platformId, null, 'blocked-user-member');
    const event = deleteEvent(entry.id, { org: { id: a.orgId, slug: 'x', role: 'member' } });
    await expect(DELETE(event)).rejects.toMatchObject({ status: 403 });
    expect(await exists(entry.id)).toBe(true);
  });

  it('allows an admin to remove a global entry', async () => {
    const a = await seedOrgWithProject('bl-admin');
    const entry = await addEntry(a.platformId, null, 'blocked-user-admin');
    const event = deleteEvent(entry.id, { org: { id: a.orgId, slug: 'x', role: 'admin' } });
    const res = await DELETE(event);
    expect(res.status).toBe(200);
    expect(await exists(entry.id)).toBe(false);
  });

  it('allows an owner to remove a project-scoped entry in their own org', async () => {
    const a = await seedOrgWithProject('bl-owner');
    const entry = await addEntry(a.platformId, a.projectId, 'blocked-user-owner');
    const event = deleteEvent(entry.id, { org: { id: a.orgId, slug: 'x', role: 'owner' } });
    const res = await DELETE(event);
    expect(res.status).toBe(200);
    expect(await exists(entry.id)).toBe(false);
  });

  it('404s a project-scoped entry belonging to a different org, without leaking it', async () => {
    const a = await seedOrgWithProject('bl-cross-a');
    const b = await seedOrgWithProject('bl-cross-b');
    const entry = await addEntry(a.platformId, a.projectId, 'blocked-user-cross');
    const event = deleteEvent(entry.id, { org: { id: b.orgId, slug: 'y', role: 'owner' } });
    await expect(DELETE(event)).rejects.toMatchObject({ status: 404 });
    expect(await exists(entry.id)).toBe(true);
  });

  it('404s for an id that does not exist', async () => {
    const a = await seedOrgWithProject('bl-missing');
    const event = deleteEvent(999999, { org: { id: a.orgId, slug: 'x', role: 'admin' } });
    await expect(DELETE(event)).rejects.toMatchObject({ status: 404 });
  });

  it('400s for a non-numeric id', async () => {
    const a = await seedOrgWithProject('bl-invalid');
    const event = deleteEvent(NaN, { org: { id: a.orgId, slug: 'x', role: 'admin' } });
    await expect(DELETE(event)).rejects.toMatchObject({ status: 400 });
  });
});
