// Retention policy for drafts, run_events, draft_events, webhook_deliveries,
// and observed_targets.
//
// Configuration lives in the existing `app_config` jsonb table under the
// `retention` key, with shape:
//   { drafts_days: 90, run_events_days: 30, draft_events_days: 90,
//     webhook_deliveries_days: 30, observed_targets_days: 3 }
//
// A floor of 7 days is enforced server-side for the four original fields so
// an accidental low value can't nuke recent data. Contact history is never
// touched by this policy - it is the long-term record used by the
// blocklist / quota systems.

import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export const RETENTION_FLOOR_DAYS = 7;

// observed_targets (#300) holds other people's post text sighted in
// passing, not outreach history - the design's own reasoning is that it
// should age out fast ("a LinkedIn post is not worth commenting on a week
// later"), well under the 7-day floor above. A separate, much lower floor
// keeps an operator from zeroing the window out by accident while still
// letting it default meaningfully shorter than every other table here.
export const OBSERVED_TARGETS_RETENTION_FLOOR_DAYS = 1;

export const RETENTION_DEFAULTS = {
  drafts_days: 90,
  run_events_days: 30,
  draft_events_days: 90,
  webhook_deliveries_days: 30,
  observed_targets_days: 3,
} as const;

export type RetentionPolicy = {
  drafts_days: number;
  run_events_days: number;
  draft_events_days: number;
  webhook_deliveries_days: number;
  observed_targets_days: number;
};

const APP_CONFIG_KEY = 'retention';

function clampDays(n: unknown, fallback: number, floor: number = RETENTION_FLOOR_DAYS): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(floor, v);
}

/**
 * Normalise an arbitrary record into a valid RetentionPolicy with floor
 * enforced. Any key missing (or invalid) in `raw` falls back to the
 * corresponding value in `base` (defaulting to RETENTION_DEFAULTS), so a
 * partial input merges over an existing policy instead of resetting the
 * fields it doesn't mention.
 */
export function normaliseRetention(
  raw: Partial<Record<keyof RetentionPolicy, unknown>> | null | undefined,
  base: RetentionPolicy = RETENTION_DEFAULTS,
): RetentionPolicy {
  const r = raw ?? {};
  return {
    drafts_days: clampDays(r.drafts_days, base.drafts_days),
    run_events_days: clampDays(r.run_events_days, base.run_events_days),
    draft_events_days: clampDays(r.draft_events_days, base.draft_events_days),
    webhook_deliveries_days: clampDays(r.webhook_deliveries_days, base.webhook_deliveries_days),
    observed_targets_days: clampDays(
      r.observed_targets_days,
      base.observed_targets_days,
      OBSERVED_TARGETS_RETENTION_FLOOR_DAYS,
    ),
  };
}

export async function loadRetention(db: Db): Promise<RetentionPolicy> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, APP_CONFIG_KEY))
    .limit(1);
  return normaliseRetention(row?.value as Partial<RetentionPolicy> | undefined);
}

export async function saveRetention(
  db: Db,
  input: Partial<RetentionPolicy>,
): Promise<RetentionPolicy> {
  // Merge over the currently stored policy so a caller that only submits a
  // subset of fields (e.g. the Settings form) doesn't clobber the rest back
  // to RETENTION_DEFAULTS.
  const current = await loadRetention(db);
  const next = normaliseRetention(input, current);
  await db
    .insert(schema.appConfig)
    .values({ key: APP_CONFIG_KEY, value: next })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: next } });
  return next;
}
