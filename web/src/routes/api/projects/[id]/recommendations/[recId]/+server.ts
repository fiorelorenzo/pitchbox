import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

function parseId(s: string | undefined): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  const recId = parseId(params.recId);
  if (!id || !recId) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');
  const db = getDb();
  const result = await db
    .delete(schema.campaignRecommendations)
    .where(
      and(
        eq(schema.campaignRecommendations.id, recId),
        eq(schema.campaignRecommendations.projectId, id),
      ),
    )
    .returning({ id: schema.campaignRecommendations.id });
  if (result.length === 0) return json({ error: 'not_found' }, { status: 404 });
  return json({ ok: true });
}
