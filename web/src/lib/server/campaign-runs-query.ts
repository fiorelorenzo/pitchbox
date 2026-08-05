import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db.js';

export const CAMPAIGN_RUNS_PAGE_SIZE = 30;

export type CampaignRunsCursor = { startedAt: Date; id: string } | null;

// Cursor pagination (see /audit): order by (started_at, id) desc, both
// descending, so the cursor tuple is monotonic and stable under concurrent
// inserts - a timestamp alone could tie and skip/duplicate rows.
export function parseCampaignRunsCursor(url: URL): CampaignRunsCursor {
  const cursorAtRaw = url.searchParams.get('cursor_at');
  const cursorIdRaw = url.searchParams.get('cursor_id');
  return cursorAtRaw && cursorIdRaw && !Number.isNaN(new Date(cursorAtRaw).getTime())
    ? { startedAt: new Date(cursorAtRaw), id: cursorIdRaw }
    : null;
}

type RunRow = typeof schema.runs.$inferSelect;

export type CampaignRun = {
  id: number;
  kind: string;
  status: string;
  trigger: string;
  agentRunner: string;
  startedAt: string;
  finishedAt: string | null;
  draftCount: number;
  durationMs: number | null;
  tokensUsed: number | null;
  costUsd: string | number | null;
  failureReason: string | null;
};

/**
 * Enriches raw `runs` rows with the draft count (campaign-kind runs only -
 * skill-generation runs never produce drafts) and a computed duration, and
 * serializes the date columns to ISO strings so the shape stays simple
 * across the wire. Shared by the page loader (first page, plus the
 * out-of-band `?run=` fetch) and the "Load more" JSON endpoint (subsequent
 * pages) so the two never drift.
 */
export async function enrichCampaignRuns(db: Db, rows: RunRow[]): Promise<CampaignRun[]> {
  const campaignRunIds = rows.filter((r) => r.kind === 'campaign').map((r) => r.id);
  const draftCounts =
    campaignRunIds.length > 0
      ? await db
          .select({ runId: schema.drafts.runId, n: count() })
          .from(schema.drafts)
          .where(inArray(schema.drafts.runId, campaignRunIds))
          .groupBy(schema.drafts.runId)
      : [];
  const draftsByRun = new Map(draftCounts.map((d) => [d.runId, Number(d.n)]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    trigger: r.trigger,
    agentRunner: r.agentRunner,
    startedAt: r.startedAt
      ? new Date(r.startedAt).toISOString()
      : (r.startedAt as unknown as string),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    draftCount: r.kind === 'campaign' ? (draftsByRun.get(r.id) ?? 0) : 0,
    durationMs:
      r.finishedAt && r.startedAt
        ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
        : null,
    tokensUsed: r.tokensUsed,
    costUsd: r.costUsd,
    failureReason: r.failureReason,
  }));
}

export type CampaignRunsPage = {
  rows: RunRow[];
  totalCount: number;
  nextCursor: { startedAt: string; id: string } | null;
};

/**
 * Runs the paginated run-history query for one campaign (every run kind,
 * newest first). Used by both the page loader (first page) and the "Load
 * more" JSON endpoint (subsequent pages) so the SQL never drifts between
 * them - see /audit for the pattern this mirrors. Returns raw rows rather
 * than enriched ones so a caller that only needs a handful of
 * skill-generation runs (the Tuning tab, the Overview skill widget) is not
 * forced to also pay for the drafts-count enrichment it never uses.
 */
export async function queryCampaignRunsPage(
  db: Db,
  campaignId: number,
  cursor: CampaignRunsCursor,
  pageSize = CAMPAIGN_RUNS_PAGE_SIZE,
): Promise<CampaignRunsPage> {
  const [totalRow] = await db
    .select({ n: count() })
    .from(schema.runs)
    .where(eq(schema.runs.campaignId, campaignId));
  const totalCount = Number(totalRow?.n ?? 0);

  const filters: SQL[] = [eq(schema.runs.campaignId, campaignId)];
  if (cursor) {
    filters.push(
      sql`(${schema.runs.startedAt}, ${schema.runs.id}) < (${cursor.startedAt.toISOString()}::timestamptz, ${cursor.id}::bigint)`,
    );
  }

  const rows = await db
    .select()
    .from(schema.runs)
    .where(and(...filters))
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(pageSize);

  const nextCursor =
    rows.length === pageSize
      ? {
          startedAt: new Date(rows[rows.length - 1].startedAt).toISOString(),
          id: String(rows[rows.length - 1].id),
        }
      : null;

  return { rows, totalCount, nextCursor };
}

/**
 * Fetches a single run by id, scoped to the campaign - the out-of-band
 * lookup for a `?run=<id>` deep link (#239) that falls outside the loaded
 * page window (#259). Returns null both when the run does not exist and
 * when it belongs to a different campaign, so a foreign or bogus id is
 * indistinguishable from "not found" to the caller.
 */
export async function fetchCampaignRunById(
  db: Db,
  campaignId: number,
  runId: number,
): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.campaignId, campaignId)));
  return row ?? null;
}
