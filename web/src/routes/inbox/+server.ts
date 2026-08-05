import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { resolveOrgId } from '$lib/server/auth.js';
import {
  resolveInboxScope,
  queryInboxDraftsPage,
  parseInboxCursor,
} from '$lib/server/inbox-query.js';

/**
 * Backs the "Load more" append on /inbox. Same scope resolution and query as
 * the page loader (`resolveInboxScope` + `queryInboxDraftsPage`), returned
 * as JSON instead of a full page render. Content-negotiated against the
 * co-located `+page.server.ts` by the Accept header (see /audit).
 */
export async function GET(event: RequestEvent) {
  const db = getDb();
  const orgId = await resolveOrgId(event);
  const scope = await resolveInboxScope(db, orgId, event.url);

  if (scope.empty) {
    return json({
      drafts: [],
      nextCursor: null,
      totalCount: 0,
      usage: {},
      quotaLimitsByPlatform: {},
    });
  }

  const cursor = parseInboxCursor(event.url);
  const { drafts, totalCount, nextCursor, usage, quotaLimitsByPlatform } =
    await queryInboxDraftsPage(db, scope, cursor);

  return json({ drafts, totalCount, nextCursor, usage, quotaLimitsByPlatform });
}
