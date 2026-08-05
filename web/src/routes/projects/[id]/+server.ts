import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import { queryProjectRunsPage, parseProjectRunsCursor } from '$lib/server/project-runs-query.js';

/**
 * Backs the "Load more" append on the project detail page's extraction
 * history table. Same query as the page loader (`queryProjectRunsPage`),
 * returned as JSON instead of a full page render. Content-negotiated
 * against the co-located `+page.server.ts` by the Accept header (see
 * /audit).
 */
export async function GET(event: RequestEvent) {
  const { params, url } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const db = getDb();
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(db, id, orgId))) throw error(404, 'not_found');

  const cursor = parseProjectRunsCursor(url);
  const page = await queryProjectRunsPage(db, id, cursor);
  return json(page);
}
