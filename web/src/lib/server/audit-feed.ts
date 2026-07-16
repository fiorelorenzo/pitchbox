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
 * Returns a unified, time-ordered feed of draft_events and run_events,
 * scoped to `orgId`. Uses UNION ALL with a discriminated `kind` column and
 * applies filters on each leg before the union for index friendliness.
 *
 * The draft leg is scoped by joining draft_events -> drafts -> projects and
 * matching `projects.organization_id`. The run leg mirrors the join used by
 * `runBelongsToOrg` in `@pitchbox/shared/orgs`: `runs.project_id` covers
 * non-campaign runs (project_extraction, project_insights,
 * draft_regeneration, reply_drafting) while `runs.campaign_id ->
 * campaigns.project_id` covers campaign runs; `campaign_id` is nullable so a
 * plain inner join through campaigns would miss the former, hence the OR.
 */
export async function loadAuditFeed(
  orgId: number,
  filters: AuditFilters = {},
): Promise<AuditRow[]> {
  const db = getDb();
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  // Build dynamic where fragments per leg.
  const draftWhere = sql.empty();
  draftWhere.append(sql`true`);
  if (filters.event) draftWhere.append(sql` and de.event = ${filters.event}`);
  if (filters.actor) draftWhere.append(sql` and de.actor = ${filters.actor}`);
  if (filters.draftId !== undefined) draftWhere.append(sql` and de.draft_id = ${filters.draftId}`);
  if (filters.from) draftWhere.append(sql` and de.created_at >= ${filters.from.toISOString()}`);
  if (filters.to) draftWhere.append(sql` and de.created_at <= ${filters.to.toISOString()}`);
  // When filtering by run_id, the draft leg is irrelevant.
  if (filters.runId !== undefined) draftWhere.append(sql` and false`);

  const runWhere = sql.empty();
  runWhere.append(sql`true`);
  if (filters.event) runWhere.append(sql` and re.kind = ${filters.event}`);
  if (filters.runId !== undefined) runWhere.append(sql` and re.run_id = ${filters.runId}`);
  if (filters.from) runWhere.append(sql` and re.created_at >= ${filters.from.toISOString()}`);
  if (filters.to) runWhere.append(sql` and re.created_at <= ${filters.to.toISOString()}`);
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
        de.id::text as id,
        de.event as event,
        de.actor as actor,
        de.draft_id as draft_id,
        null::int as run_id,
        de.details as details,
        de.created_at as created_at
      from draft_events de
      join drafts d on d.id = de.draft_id
      join projects p on p.id = d.project_id
      where p.organization_id = ${orgId} and ${draftWhere}
      union all
      select
        'run'::text as kind,
        re.id::text as id,
        re.kind as event,
        null::text as actor,
        null::int as draft_id,
        re.run_id as run_id,
        re.payload as details,
        re.created_at as created_at
      from run_events re
      join runs r on r.id = re.run_id
      left join campaigns c on c.id = r.campaign_id
      join projects p2 on p2.id = r.project_id or p2.id = c.project_id
      where p2.organization_id = ${orgId} and ${runWhere}
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
