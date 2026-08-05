import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db.js';

export const PROJECT_RUNS_PAGE_SIZE = 30;

export type ProjectRunsCursor = { startedAt: Date; id: string } | null;

// Cursor pagination (see /audit): order by (started_at, id) desc, both
// descending, so the cursor tuple is monotonic and stable under concurrent
// inserts - a timestamp alone could tie and skip/duplicate rows.
export function parseProjectRunsCursor(url: URL): ProjectRunsCursor {
  const cursorAtRaw = url.searchParams.get('cursor_at');
  const cursorIdRaw = url.searchParams.get('cursor_id');
  return cursorAtRaw && cursorIdRaw && !Number.isNaN(new Date(cursorAtRaw).getTime())
    ? { startedAt: new Date(cursorAtRaw), id: cursorIdRaw }
    : null;
}

type RunRow = typeof schema.runs.$inferSelect;

export type ProjectExtractionRun = {
  id: number;
  status: string;
  trigger: string;
  agentRunner: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokensUsed: number | null;
  error: string | null;
  params: { source?: { kind: string; value: string } } | null;
};

export function serializeExtractionRun(r: RunRow): ProjectExtractionRun {
  const startedAtMs =
    r.startedAt instanceof Date
      ? r.startedAt.getTime()
      : new Date(r.startedAt as unknown as string).getTime();
  const finishedAtMs =
    r.finishedAt == null
      ? null
      : r.finishedAt instanceof Date
        ? r.finishedAt.getTime()
        : new Date(r.finishedAt as unknown as string).getTime();
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    agentRunner: r.agentRunner,
    startedAt:
      r.startedAt instanceof Date ? r.startedAt.toISOString() : (r.startedAt as unknown as string),
    finishedAt:
      r.finishedAt == null
        ? null
        : r.finishedAt instanceof Date
          ? r.finishedAt.toISOString()
          : (r.finishedAt as unknown as string),
    durationMs: finishedAtMs != null ? finishedAtMs - startedAtMs : null,
    tokensUsed: r.tokensUsed ?? null,
    error: r.error,
    params: (r.params ?? null) as { source?: { kind: string; value: string } } | null,
  };
}

export type ProjectRunsPage = {
  runs: ProjectExtractionRun[];
  totalCount: number;
  nextCursor: { startedAt: string; id: string } | null;
};

/**
 * Runs the paginated extraction-run-history query for one project (kind
 * 'project_extraction' only, newest first). Used by both the page loader
 * (first page) and the "Load more" JSON endpoint (subsequent pages) so the
 * SQL never drifts between them - see /audit for the pattern this mirrors.
 */
export async function queryProjectRunsPage(
  db: Db,
  projectId: number,
  cursor: ProjectRunsCursor,
  pageSize = PROJECT_RUNS_PAGE_SIZE,
): Promise<ProjectRunsPage> {
  const baseFilter = and(
    eq(schema.runs.projectId, projectId),
    eq(schema.runs.kind, 'project_extraction'),
  )!;

  const [totalRow] = await db.select({ n: count() }).from(schema.runs).where(baseFilter);
  const totalCount = Number(totalRow?.n ?? 0);

  const filters: SQL[] = [baseFilter];
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

  return { runs: rows.map(serializeExtractionRun), totalCount, nextCursor };
}

/**
 * Fetches a single project_extraction run by id, scoped to the project -
 * the out-of-band lookup for a `?run=<id>` deep link (mirrors
 * fetchCampaignRunById / #259) that falls outside the loaded page window.
 * Returns null when the run does not exist, belongs to a different
 * project, or is not a project_extraction run, so a foreign, bogus, or
 * wrong-kind id is indistinguishable from "not found" to the caller.
 */
export async function fetchProjectRunById(
  db: Db,
  projectId: number,
  runId: number,
): Promise<ProjectExtractionRun | null> {
  const [row] = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.id, runId),
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.kind, 'project_extraction'),
      ),
    );
  return row ? serializeExtractionRun(row) : null;
}
