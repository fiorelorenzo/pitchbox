import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import {
  loadAuditFeed,
  parseAuditFiltersFromUrl,
  nextAuditCursor,
} from '$lib/server/audit-feed.js';
import { requireOrgId } from '$lib/server/auth.js';

/**
 * Backs the "Load more" append on /audit. Same query as the page loader
 * (`parseAuditFiltersFromUrl` + `loadAuditFeed`), returned as JSON instead
 * of a full page render. SvelteKit negotiates this against the co-located
 * `+page.server.ts` by the request's Accept header: a browser navigation
 * (Accept: text/html) still gets the page, a `fetch` with
 * `Accept: application/json` lands here.
 */
export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const filters = parseAuditFiltersFromUrl(event.url);

  const rows = await loadAuditFeed(orgId, filters);

  return json({
    rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    nextCursor: nextAuditCursor(rows, filters.limit!),
  });
}
