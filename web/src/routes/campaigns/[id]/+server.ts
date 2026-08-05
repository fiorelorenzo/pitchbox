import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { campaignBelongsToOrg } from '@pitchbox/shared/orgs';
import {
  enrichCampaignRuns,
  queryCampaignRunsPage,
  parseCampaignRunsCursor,
} from '$lib/server/campaign-runs-query.js';

/**
 * Backs the "Load more" append on the campaign detail page's Runs tab. Same
 * query as the page loader (`queryCampaignRunsPage`), returned as JSON
 * instead of a full page render. Content-negotiated against the co-located
 * `+page.server.ts` by the Accept header (see /audit).
 */
export async function GET(event: RequestEvent) {
  const { params, url } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const db = getDb();
  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(db, id, orgId))) throw error(404, 'not_found');

  const cursor = parseCampaignRunsCursor(url);
  const { rows, totalCount, nextCursor } = await queryCampaignRunsPage(db, id, cursor);
  const runs = await enrichCampaignRuns(db, rows);

  return json({ runs, totalCount, nextCursor });
}
