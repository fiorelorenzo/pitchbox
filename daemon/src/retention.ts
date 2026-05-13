// Retention worker — runs once an hour and prunes ageing run_events,
// draft_events, and terminal drafts according to the policy stored in
// `app_config.retention`. Contact history is intentionally preserved so the
// blocklist / quota signals survive draft cleanup.
//
// Each delete is capped to a batch (10k rows) and loops until either it can't
// fill a batch or it hits a per-tick safety ceiling, keeping a single tick
// bounded on busy installs.

import { sql } from 'drizzle-orm';
import { getDb } from '@pitchbox/shared/db';
import { loadRetention, type RetentionPolicy } from '@pitchbox/shared/retention';
import { logger } from './logger.js';

const log = logger('retention');

export const RETENTION_BATCH_SIZE = 10_000;
/** Maximum batches per table per tick — prevents one tick from running for hours on first-run backfills. */
const MAX_BATCHES_PER_TABLE = 50;

const TERMINAL_DRAFT_STATES = ['sent', 'rejected', 'replied'] as const;

export interface RetentionTickResult {
  policy: RetentionPolicy;
  runEventsDeleted: number;
  draftEventsDeleted: number;
  draftsDeleted: number;
}

async function deleteRunEventsBatch(cutoffIso: string): Promise<number> {
  const res = await getDb().execute(sql`
    DELETE FROM run_events
    WHERE id IN (
      SELECT id FROM run_events
      WHERE created_at < ${cutoffIso}
      ORDER BY id
      LIMIT ${RETENTION_BATCH_SIZE}
    )
  `);
  return res.rowCount ?? 0;
}

async function deleteDraftEventsBatch(cutoffIso: string): Promise<number> {
  const res = await getDb().execute(sql`
    DELETE FROM draft_events
    WHERE id IN (
      SELECT id FROM draft_events
      WHERE created_at < ${cutoffIso}
      ORDER BY id
      LIMIT ${RETENTION_BATCH_SIZE}
    )
  `);
  return res.rowCount ?? 0;
}

async function deleteTerminalDraftsBatch(cutoffIso: string): Promise<number> {
  // Terminal drafts older than the cutoff are pruned. `created_at` is used as
  // the age proxy so drafts that never moved out of a terminal state still
  // age out (sent_at can be null on rejected rows). `contact_history.draft_id`
  // is ON DELETE SET NULL in the schema, so contact_history rows survive.
  // node-postgres needs a single array bound to ANY(), not N scalar params.
  // sql.raw is unsafe here (interpolation), so build the IN list as a fixed
  // SQL literal — TERMINAL_DRAFT_STATES is a compile-time constant.
  const states = TERMINAL_DRAFT_STATES.map((s) => `'${s}'`).join(', ');
  const res = await getDb().execute(sql`
    DELETE FROM drafts
    WHERE id IN (
      SELECT id FROM drafts
      WHERE state IN (${sql.raw(states)})
        AND created_at < ${cutoffIso}
      ORDER BY id
      LIMIT ${RETENTION_BATCH_SIZE}
    )
  `);
  return res.rowCount ?? 0;
}

async function drainTable(
  label: string,
  cutoffIso: string,
  fn: (cutoffIso: string) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
    const n = await fn(cutoffIso);
    total += n;
    if (n < RETENTION_BATCH_SIZE) break;
  }
  if (total > 0) log.info(`pruned ${total} rows from ${label}`);
  return total;
}

function cutoffIsoFromDays(days: number, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

export async function tick(): Promise<RetentionTickResult> {
  const policy = await loadRetention(getDb());

  const runEventsDeleted = await drainTable(
    'run_events',
    cutoffIsoFromDays(policy.run_events_days),
    deleteRunEventsBatch,
  );
  const draftEventsDeleted = await drainTable(
    'draft_events',
    cutoffIsoFromDays(policy.draft_events_days),
    deleteDraftEventsBatch,
  );
  const draftsDeleted = await drainTable(
    'drafts',
    cutoffIsoFromDays(policy.drafts_days),
    deleteTerminalDraftsBatch,
  );

  return { policy, runEventsDeleted, draftEventsDeleted, draftsDeleted };
}
