import { createHash } from 'node:crypto';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications, appConfig, webhookDeliveries } from './db/schema.js';

/**
 * Stable, short identifier for a webhook target. The URL itself isn't safe to
 * use as an id (PII, length), so we keep the first 16 chars of its sha256.
 */
export function webhookIdForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export type NotificationInput = {
  kind: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  severity?: NotificationSeverity;
};

const WEBHOOK_KEY = 'notification_webhooks';

export type NotificationWebhooks = {
  url?: string;
};

async function loadWebhooks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<NotificationWebhooks> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, WEBHOOK_KEY));
  return ((row?.value as NotificationWebhooks | undefined) ?? {}) as NotificationWebhooks;
}

export async function saveWebhooks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  cfg: NotificationWebhooks,
): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key: WEBHOOK_KEY, value: cfg })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: cfg } });
}

export async function notify(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  input: NotificationInput,
  orgId: number,
): Promise<void> {
  const [row] = await db
    .insert(notifications)
    .values({
      organizationId: orgId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      payload: input.payload ?? {},
      severity: input.severity ?? 'info',
    })
    .returning();

  const cfg = await loadWebhooks(db);
  if (cfg.url) {
    // Enqueue for the daemon's webhook-sender worker. We never POST inline:
    // the worker handles retries, backoff, and the dead-letter queue.
    await db.insert(webhookDeliveries).values({
      webhookId: webhookIdForUrl(cfg.url),
      eventType: `notification.${row.kind}`,
      payload: {
        url: cfg.url,
        body: {
          id: row.id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          severity: row.severity,
          payload: row.payload,
          createdAt: row.createdAt,
        },
      },
      status: 'pending',
    });
  }
}

export { loadWebhooks };

export async function listRecent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  orgId: number,
  limit = 50,
): Promise<(typeof notifications.$inferSelect)[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.organizationId, orgId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function countUnread(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  orgId: number,
): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(notifications)
    .where(and(eq(notifications.organizationId, orgId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

export async function markAllRead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  orgId: number,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.organizationId, orgId), isNull(notifications.readAt)));
}
