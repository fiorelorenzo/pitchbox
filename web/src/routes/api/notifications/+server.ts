import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import {
  listRecent,
  countUnread,
  markAllRead,
  renderNotification,
} from '@pitchbox/shared/notifications';

export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const db = getDb();
  const [items, unread] = await Promise.all([listRecent(db, orgId, 100), countUnread(db, orgId)]);
  // LOR-288: same reader-locale re-render as the /notifications page load -
  // see docs/design/DECISIONS.md.
  const notifications = items.map((n) => ({ ...n, ...renderNotification(n, event.locals.locale) }));
  return json({ notifications, unread });
}

export async function POST(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const db = getDb();
  await markAllRead(db, orgId);
  const unread = await countUnread(db, orgId);
  return json({ unread });
}
