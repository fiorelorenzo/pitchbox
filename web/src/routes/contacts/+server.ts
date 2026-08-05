import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { resolveContactsScope, queryContactsPage } from '$lib/server/contacts-query.js';

/**
 * Backs the "Load more" append on /contacts. Same scope resolution and
 * query as the page loader (`resolveContactsScope` + `queryContactsPage`),
 * returned as JSON instead of a full page render. Content-negotiated
 * against the co-located `+page.server.ts` by the Accept header (see
 * /audit).
 */
export async function GET(event: RequestEvent) {
  const db = getDb();
  const orgId = await requireOrgId(event);
  const scope = await resolveContactsScope(db, orgId, event.url);
  const { contacts, matchingCount, nextCursor } = await queryContactsPage(db, scope);
  return json({ contacts, matchingCount, nextCursor });
}
