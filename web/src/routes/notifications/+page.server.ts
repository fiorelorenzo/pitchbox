import { desc } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { listRecent, loadWebhooks } from '@pitchbox/shared/notifications';

export async function load() {
  const db = getDb();
  const [items, webhooks, deliveries] = await Promise.all([
    listRecent(db, 100),
    loadWebhooks(db),
    db
      .select()
      .from(schema.webhookDeliveries)
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(50),
  ]);
  return { notifications: items, webhooks, deliveries };
}
