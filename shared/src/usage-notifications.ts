// Usage-threshold notifications (#557): a hard stop that arrives without
// warning reads as a bug. The pieces to warn with already exist -
// `notifications` (in-app, with an unread badge), the webhook delivery
// queue `notify()` already enqueues to when an org has a webhook configured
// (`billing_payment_failed`, #611), and an email path since the accounts
// work - so this is the second producer that reuses all three rather than
// inventing a second mechanism.
//
// The only real difficulty is "once per threshold per period": a burst of
// requests all computing the same usage snapshot at the boundary must not
// send five notifications, staying over the threshold on the next request
// must not send a second one, and the period rolling over must notify
// again. There is no migration slot this wave (AssistPlane holds it), so
// this follows #611's own precedent exactly instead of adding a dedicated
// dedupe table: a `notifications` row already recorded for
// (org, metric, threshold, period) *is* the record. That is a
// check-then-insert, the same narrow race #611 itself accepts (two requests
// landing in the same instant could both pass the check and double-insert) -
// not closed here either, since closing it for real needs a partial unique
// index and hence the migration slot nobody has this wave.
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { schema } from './db/client.js';
import { notify } from './notifications.js';
import type { OrgUsageSnapshot, UsageMetric } from './usage.js';
import type { Period } from './org-quota.js';
import { t, DEFAULT_LOCALE } from './messages/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = PgDatabase<any, any, any>;

export const USAGE_THRESHOLD_NOTIFICATION_KIND = 'usage_threshold_reached';

const THRESHOLDS = [80, 100] as const;
export type UsageThreshold = (typeof THRESHOLDS)[number];

/** Every axis `OrgUsageSnapshot` can actually refuse against. `accounts` is
 * deliberately excluded - usage.ts's own doc comment on that field: "limit
 * is always null... no enforcement point reads a connected-account limit
 * yet", so it can never have a threshold to cross. */
const METERED_AXES = [
  'runs',
  'suggestions',
  'projects',
  'seats',
  'extensionDevices',
  'costUsd',
] as const;
type MeteredAxis = (typeof METERED_AXES)[number];

/**
 * At 80% and 100% of any metered axis in `usage`, emit one
 * `usage_threshold_reached` notification per axis per threshold per
 * `period` - idempotent by construction (see the module header) and safe to
 * call on every request that already computes a usage snapshot for
 * enforcement: an axis with nothing new to report does no writes at all.
 *
 * An unlimited axis (`limit === null`) never produces one, which is also
 * why self-host - `getOrgUsage`'s fully-unlimited shape - never notifies:
 * there is nothing here that treats `source === 'self-host'` specially: it
 * doesn't need to, since every axis is already unlimited by the time this
 * runs.
 */
export async function checkUsageThresholds(
  db: AnyDb,
  orgId: number,
  usage: OrgUsageSnapshot,
  period: Period,
): Promise<void> {
  const periodEnd = period.end.toISOString();

  const crossed: { axis: MeteredAxis; threshold: UsageThreshold; metric: UsageMetric }[] = [];
  for (const axis of METERED_AXES) {
    const metric = usage[axis];
    // Unlimited (`limit === null`, always true on self-host) or a
    // zero-or-negative limit: neither has a meaningful percentage, so it
    // can never cross a threshold.
    if (metric.limit == null || metric.limit <= 0) continue;
    const percent = (metric.used / metric.limit) * 100;
    for (const threshold of THRESHOLDS) {
      if (percent >= threshold) crossed.push({ axis, threshold, metric });
    }
  }
  if (crossed.length === 0) return;

  // One round trip for every dedupe key already recorded this period,
  // rather than one SELECT per (axis, threshold) - the whole point is this
  // stays cheap enough to call from a request that is already computing the
  // usage snapshot for its own enforcement check.
  const existingKeys = new Set(
    (
      await db
        .select({ key: sql<string>`${schema.notifications.payload}->>'dedupeKey'` })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.organizationId, orgId),
            eq(schema.notifications.kind, USAGE_THRESHOLD_NOTIFICATION_KIND),
            sql`${schema.notifications.payload}->>'periodEnd' = ${periodEnd}`,
          ),
        )
    ).map((row) => row.key),
  );

  for (const { axis, threshold, metric } of crossed) {
    const dedupeKey = `${axis}:${threshold}:${periodEnd}`;
    if (existingKeys.has(dedupeKey)) continue;
    existingKeys.add(dedupeKey); // guard against this same loop double-firing

    // costUsd reads as a dollar figure, every other axis as a whole count -
    // both formatted together so the ternary isn't repeated per value.
    const { used: usedText, limit: limitText } =
      axis === 'costUsd'
        ? { used: `$${metric.used.toFixed(2)}`, limit: `$${(metric.limit as number).toFixed(2)}` }
        : {
            used: String(Math.round(metric.used)),
            limit: String(Math.round(metric.limit as number)),
          };
    const periodEndDate = periodEnd.slice(0, 10);

    // Per-axis keys rather than one template with an interpolated label:
    // the label itself needs its own translation, and `interpolate()`
    // only does flat string substitution, so re-resolving a label per
    // locale inside a shared template would need a second, nested `t()`
    // call this avoids entirely - the same "dynamic key from a literal
    // union" shape `dict-en.ts`'s own `api.uploads.reason.*` already
    // uses. `title`/`body` below stay the `DEFAULT_LOCALE` rendering,
    // read by the outgoing webhook payload below and by any consumer
    // that reads the raw columns without going through
    // `renderNotification`; `payload.i18n*` is what a reader-locale
    // render (`shared/src/notifications.ts`'s `renderNotification`)
    // uses instead - see docs/design/DECISIONS.md.
    const titleKey = `usageNotification.title.${axis}`;
    const titleParams = { threshold };
    const bodyKey = `usageNotification.body.${axis}`;
    const bodyParams = { usedText, limitText, periodEnd: periodEndDate };

    await notify(
      db,
      {
        kind: USAGE_THRESHOLD_NOTIFICATION_KIND,
        title: t(DEFAULT_LOCALE, titleKey, titleParams),
        severity: threshold >= 100 ? 'warning' : 'info',
        body: t(DEFAULT_LOCALE, bodyKey, bodyParams),
        payload: {
          dedupeKey,
          metric: axis,
          threshold,
          used: metric.used,
          limit: metric.limit,
          periodEnd,
          i18nTitleKey: titleKey,
          i18nTitleParams: titleParams,
          i18nBodyKey: bodyKey,
          i18nBodyParams: bodyParams,
        },
      },
      orgId,
    );
  }
}
