import { desc, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { listRecent, loadWebhooks } from '@pitchbox/shared/notifications';

export async function load(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const db = getDb();
  const [items, webhooks, deliveries] = await Promise.all([
    listRecent(db, orgId, 100),
    loadWebhooks(db),
    db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.organizationId, orgId))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(50),
  ]);
  return { notifications: items, webhooks, deliveries };
}
