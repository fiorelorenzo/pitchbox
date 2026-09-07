import { error, type RequestEvent } from '@sveltejs/kit';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { getDb } from '$lib/server/db.js';
import { removeGithubSource } from '@pitchbox/shared/github-sources';

// Admin-gated, same level as the collection route's POST. `removeGithubSource`
// scopes its delete by organizationId itself, so a valid id from a different
// organization deletes nothing and this answers 404 - never a 403 that would
// confirm the id exists at all.
export async function DELETE(event: RequestEvent) {
  const id = Number(event.params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid_id');

  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');

  const removed = await removeGithubSource(getDb(), orgId, id);
  if (!removed) throw error(404, 'not_found');
  return new Response(null, { status: 204 });
}
