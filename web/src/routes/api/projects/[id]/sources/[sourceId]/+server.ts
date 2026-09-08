import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { deleteProjectSource } from '@pitchbox/shared/project-sources';

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Admin-gated, same level as the collection route's POST. `deleteProjectSource`
// scopes by organizationId itself (via the source's project), so an id from a
// different organization deletes nothing and this still answers 404 rather
// than a 403 that would confirm the id exists.
export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const projectId = parseId(params.id);
  const sourceId = parseId(params.sourceId);
  if (!projectId || !sourceId) throw error(400, 'invalid_id');
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), projectId, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');

  const deleted = await deleteProjectSource(getDb(), orgId, sourceId);
  if (!deleted) throw error(404, 'not_found');
  return json({ ok: true });
}
