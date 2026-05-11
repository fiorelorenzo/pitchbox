import { getDb } from '$lib/server/db.js';
import { listRecent, loadWebhooks } from '@pitchbox/shared/notifications';

export async function load() {
  const db = getDb();
  const [items, webhooks] = await Promise.all([listRecent(db, 100), loadWebhooks(db)]);
  return { notifications: items, webhooks };
}
