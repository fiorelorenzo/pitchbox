import { sql } from 'drizzle-orm';
import { getDb } from './db.js';

export type AuditFilters = {
  actor?: string;
  event?: string;
  draftId?: number;
  runId?: number;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: { createdAt: Date; id: string } | null;
};

export type AuditRow = {
  kind: 'draft' | 'run';
  id: string;
  event: string;
  actor: string | null;
  draftId: number | null;
  runId: number | null;
  details: unknown;
  createdAt: Date;
};

/**
 * Returns a unified, time-ordered feed of draft_events and run_events.
 * Uses UNION ALL with a discriminated `kind` column and applies filters
 * on each leg before the union for index friendliness.
 */
export async function loadAuditFeed(filters: AuditFilters = {}): Promise<AuditRow[]> {
  const db = getDb();
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  // Build dynamic where fragments per leg.
  const draftWhere = sql.empty();
  draftWhere.append(sql`true`);
  if (filters.event) draftWhere.append(sql` and event = ${filters.event}`);
  if (filters.actor) draftWhere.append(sql` and actor = ${filters.actor}`);
  if (filters.draftId !== undefined) draftWhere.append(sql` and draft_id = ${filters.draftId}`);
  if (filters.from) draftWhere.append(sql` and created_at >= ${filters.from.toISOString()}`);
  if (filters.to) draftWhere.append(sql` and created_at <= ${filters.to.toISOString()}`);
  // When filtering by run_id, the draft leg is irrelevant.
  if (filters.runId !== undefined) draftWhere.append(sql` and false`);

  const runWhere = sql.empty();
  runWhere.append(sql`true`);
  if (filters.event) runWhere.append(sql` and kind = ${filters.event}`);
  if (filters.runId !== undefined) runWhere.append(sql` and run_id = ${filters.runId}`);
  if (filters.from) runWhere.append(sql` and created_at >= ${filters.from.toISOString()}`);
  if (filters.to) runWhere.append(sql` and created_at <= ${filters.to.toISOString()}`);
  // run_events has no actor or draft_id column.
  if (filters.actor) runWhere.append(sql` and false`);
  if (filters.draftId !== undefined) runWhere.append(sql` and false`);

  const cursorClause = filters.cursor
    ? sql` where (created_at, id) < (${filters.cursor.createdAt.toISOString()}::timestamptz, ${filters.cursor.id}::bigint)`
    : sql.empty();

  const rows = await db.execute<{
    kind: 'draft' | 'run';
    id: string;
    event: string;
    actor: string | null;
    draft_id: number | null;
    run_id: number | null;
    details: unknown;
    created_at: Date;
  }>(sql`
    with feed as (
      select
        'draft'::text as kind,
        id::text as id,
        event as event,
        actor as actor,
        draft_id as draft_id,
        null::int as run_id,
        details as details,
        created_at as created_at
      from draft_events
      where ${draftWhere}
      union all
      select
        'run'::text as kind,
        id::text as id,
        kind as event,
        null::text as actor,
        null::int as draft_id,
        run_id as run_id,
        payload as details,
        created_at as created_at
      from run_events
      where ${runWhere}
    )
    select * from feed
    ${cursorClause}
    order by created_at desc, id desc
    limit ${limit}
  `);

  return rows.rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    event: r.event,
    actor: r.actor,
    draftId: r.draft_id,
    runId: r.run_id,
    details: r.details,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
  }));
}

/**
 * Returns the distinct set of event names across both tables, so the filter
 * dropdown can be populated without hardcoding values.
 */
export async function loadAuditEventTypes(): Promise<string[]> {
  const db = getDb();
  const res = await db.execute<{ event: string }>(sql`
    select distinct event from (
      select event from draft_events
      union
      select kind as event from run_events
    ) e
    order by event asc
  `);
  return res.rows.map((r) => r.event);
}
