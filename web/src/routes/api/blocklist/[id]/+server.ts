import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  const db = getDb();
  // Global rows (projectId === null) are a shared resource visible to every
  // org - only project-scoped rows are tenant-checked here.
  const [row] = await db.select().from(schema.blocklist).where(eq(schema.blocklist.id, id));
  if (!row) throw error(404, 'not_found');
  if (row.projectId && !(await projectBelongsToOrg(db, row.projectId, orgId))) {
    throw error(404, 'not_found');
  }
  const deleted = await db.delete(schema.blocklist).where(eq(schema.blocklist.id, id)).returning();
  if (deleted.length === 0) throw error(404, 'not found');
  return json({ ok: true, id });
}
