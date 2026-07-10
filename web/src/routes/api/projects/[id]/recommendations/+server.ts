import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

function parseId(idParam: string | undefined): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.campaignRecommendations)
    .where(eq(schema.campaignRecommendations.projectId, id))
    .orderBy(desc(schema.campaignRecommendations.createdAt));
  return json({ recommendations: rows });
}
