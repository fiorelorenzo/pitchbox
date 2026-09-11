import { desc, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { listRecent, loadWebhooks, renderNotification } from '@pitchbox/shared/notifications';

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
  // LOR-288: a notifications row is organization-wide and stores a
  // machine key plus params rather than one fixed locale's text
  // (docs/design/DECISIONS.md) - re-rendered here in this reader's own
  // event.locals.locale, the same value D46/D47 already resolve.
  const notifications = items.map((n) => ({ ...n, ...renderNotification(n, event.locals.locale) }));
  return { notifications, webhooks, deliveries };
}
