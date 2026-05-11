import type { PgDatabase } from 'drizzle-orm/pg-core';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications, appConfig } from './db/schema.js';

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
): Promise<void> {
  const [row] = await db
    .insert(notifications)
    .values({
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      payload: input.payload ?? {},
      severity: input.severity ?? 'info',
    })
    .returning();

  const cfg = await loadWebhooks(db);
  if (cfg.url) {
    // Fire and forget — webhook failures must not block the producer.
    void fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        severity: row.severity,
        payload: row.payload,
        createdAt: row.createdAt,
      }),
    }).catch((err) => {
      console.error('[notify] webhook failed:', err);
    });
  }
}

export { loadWebhooks };

export async function listRecent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  limit = 50,
): Promise<(typeof notifications.$inferSelect)[]> {
  return db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
}

export async function countUnread(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(notifications)
    .where(isNull(notifications.readAt));
  return r?.n ?? 0;
}

export async function markAllRead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<void> {
  await db.update(notifications).set({ readAt: new Date() }).where(isNull(notifications.readAt));
}
