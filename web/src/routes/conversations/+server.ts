import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { resolveOrgId } from '$lib/server/auth.js';
import {
  resolveConversationsScope,
  queryConversationsPage,
} from '$lib/server/conversations-query.js';

/**
 * Backs the "Load more" append on /conversations. Same scope resolution and
 * query as the page loader (`resolveConversationsScope` +
 * `queryConversationsPage`, including the message-body search), returned as
 * JSON instead of a full page render. Content-negotiated against the
 * co-located `+page.server.ts` by the Accept header (see /audit).
 */
export async function GET(event: RequestEvent) {
  const db = getDb();
  const orgId = await resolveOrgId(event);
  const scope = await resolveConversationsScope(db, orgId, event.url);
  const { conversations, nextCursor } = await queryConversationsPage(db, scope);
  return json({ conversations, nextCursor });
}
