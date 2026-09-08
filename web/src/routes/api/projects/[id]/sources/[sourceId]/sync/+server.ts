import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { syncProjectSource } from '@pitchbox/shared/project-source-sync';

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Re-syncs one source (#432). Admin-gated, same level as add/remove.
// `syncProjectSource` never throws for a fetch failure - a source with no
// fetcher wired up yet, or one whose network call failed, comes back
// `ok: false` with a human-readable `fetch_error` on the row, not a 500.
export async function POST(event: RequestEvent) {
  const { params } = event;
  const projectId = parseId(params.id);
  const sourceId = parseId(params.sourceId);
  if (!projectId || !sourceId) throw error(400, 'invalid_id');
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), projectId, orgId))) throw error(404, 'not_found');
  requireRole(event, 'admin');

  const result = await syncProjectSource(getDb(), orgId, sourceId);
  if (!result) throw error(404, 'not_found');
  return json({ ok: result.ok, source: result.source });
}
