import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq, asc } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const events = await db
    .select()
    .from(schema.draftEvents)
    .where(eq(schema.draftEvents.draftId, id))
    .orderBy(asc(schema.draftEvents.createdAt));
  return json(events);
}
