// Retention policy for drafts, run_events, and draft_events.
//
// Configuration lives in the existing `app_config` jsonb table under the
// `retention` key, with shape:
//   { drafts_days: 90, run_events_days: 30, draft_events_days: 90 }
//
// A floor of 7 days is enforced server-side so an accidental low value can't
// nuke recent data. Contact history is never touched by this policy — it is
// the long-term record used by the blocklist / quota systems.

import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export const RETENTION_FLOOR_DAYS = 7;

export const RETENTION_DEFAULTS = {
  drafts_days: 90,
  run_events_days: 30,
  draft_events_days: 90,
} as const;

export type RetentionPolicy = {
  drafts_days: number;
  run_events_days: number;
  draft_events_days: number;
};

const APP_CONFIG_KEY = 'retention';

function clampDays(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(RETENTION_FLOOR_DAYS, v);
}

/** Normalise an arbitrary record into a valid RetentionPolicy with floor enforced. */
export function normaliseRetention(
  raw: Partial<Record<keyof RetentionPolicy, unknown>> | null | undefined,
): RetentionPolicy {
  const r = raw ?? {};
  return {
    drafts_days: clampDays(r.drafts_days, RETENTION_DEFAULTS.drafts_days),
    run_events_days: clampDays(r.run_events_days, RETENTION_DEFAULTS.run_events_days),
    draft_events_days: clampDays(r.draft_events_days, RETENTION_DEFAULTS.draft_events_days),
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
  const next = normaliseRetention(input);
  await db
    .insert(schema.appConfig)
    .values({ key: APP_CONFIG_KEY, value: next })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: next } });
  return next;
}
