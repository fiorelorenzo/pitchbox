import { createHash } from 'node:crypto';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications, appConfig, webhookDeliveries } from './db/schema.js';
import { t, type Locale, type MessageParams } from './messages/index.js';

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

/**
 * LOR-288: a `notifications` row is organization-wide, and its readers do
 * not all share one `Locale` (`users.locale` is per-account, not per-org -
 * see `shared/src/db/schema.ts`'s `users.locale` comment). Baking a
 * rendered sentence into `title`/`body` at write time therefore picks a
 * winner among readers who have not been decided yet, and is wrong for
 * every reader who is not that winner. `docs/design/DECISIONS.md` records
 * the decision this shape implements: keep `title`/`body` as the
 * `DEFAULT_LOCALE` rendering (for the two locale-blind consumers, the
 * outgoing webhook payload below and any legacy reader of the raw
 * columns), and additionally store the machine key plus params a producer
 * rendered them from, so `renderNotification` below can re-render in
 * whichever locale the *current* reader's request resolved
 * (`event.locals.locale` on web, the same value D46/D47 already compute) -
 * every time the row is listed for display, not once at insert time.
 *
 * `payload.i18nTitleKey`/`i18nTitleParams` are required together;
 * `i18nBodyKey`/`i18nBodyParams` are optional (a notification with no
 * body has nothing to re-render). Every other `payload` field
 * (`checkUsageThresholds`'s `metric`/`threshold`/`used`/`limit`/
 * `periodEnd`) is untouched by this convention - it stays whatever shape
 * its producer already gave it.
 */
export type NotificationI18nPayload = {
  i18nTitleKey?: string;
  i18nTitleParams?: MessageParams;
  i18nBodyKey?: string;
  i18nBodyParams?: MessageParams;
};

export type NotificationRow = {
  title: string;
  body: string | null;
  payload: unknown;
};

/**
 * A row with no `i18nTitleKey` - every notification kind that has not
 * adopted the convention above, and every row written before it landed -
 * returns its stored `title`/`body` unchanged: a legacy row keeps showing
 * exactly what its reader already saw, never a blank or a raw key name.
 */
export function renderNotification(
  row: NotificationRow,
  locale: Locale,
): { title: string; body: string | null } {
  const payload = (row.payload ?? {}) as NotificationI18nPayload;
  if (typeof payload.i18nTitleKey !== 'string') {
    return { title: row.title, body: row.body };
  }
  const title = t(locale, payload.i18nTitleKey, payload.i18nTitleParams);
  const body =
    typeof payload.i18nBodyKey === 'string'
      ? t(locale, payload.i18nBodyKey, payload.i18nBodyParams)
      : row.body;
  return { title, body };
}

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
      organizationId: orgId,
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
