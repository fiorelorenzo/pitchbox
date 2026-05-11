import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { listRecent, countUnread, markAllRead } from '@pitchbox/shared/notifications';

export async function GET() {
  const db = getDb();
  const [items, unread] = await Promise.all([listRecent(db, 100), countUnread(db)]);
  return json({ notifications: items, unread });
}

export async function POST() {
  const db = getDb();
  await markAllRead(db);
  const unread = await countUnread(db);
  return json({ unread });
}
