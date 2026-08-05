import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { getProjectById } from '@pitchbox/shared/projects';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';
import {
  queryProjectRunsPage,
  parseProjectRunsCursor,
  fetchProjectRunById,
} from '$lib/server/project-runs-query.js';

export const load: PageServerLoad = async (event) => {
  const { params, url } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) throw error(404, 'project not found');
  const cursor = parseProjectRunsCursor(url);
  const [accounts, platforms, extractionRunsPage, recommendations, templates, latestInsight] =
    await Promise.all([
      db.select().from(schema.accounts).where(eq(schema.accounts.projectId, id)),
      db.select().from(schema.platforms),
      queryProjectRunsPage(db, id, cursor),
      db
        .select()
        .from(schema.campaignRecommendations)
        .where(eq(schema.campaignRecommendations.projectId, id))
        .orderBy(desc(schema.campaignRecommendations.createdAt)),
      db
        .select()
        .from(schema.templates)
        .where(eq(schema.templates.projectId, id))
        .orderBy(desc(schema.templates.createdAt)),
      db
        .select()
        .from(schema.projectInsights)
        .where(eq(schema.projectInsights.projectId, id))
        .orderBy(desc(schema.projectInsights.generatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
  let {
    runs: extractionRuns,
    totalCount: extractionRunsTotalCount,
    nextCursor: extractionRunsNextCursor,
  } = extractionRunsPage;

  // A `?run=<id>` deep link (mirrors the campaign detail page's - #239,
  // #259) can target an extraction run older than this first page: fetch
  // it out of band and splice it into the rows handed to the Overview tab
  // so it is present and highlightable on first load, rather than hoping
  // the user pages far enough to reach it. Cursor pagination never touches
  // the address bar (the "Load more" fetch builds its own URL - see
  // ProjectExtractionRunsTable.svelte), so a non-null cursor here means
  // this is not a fresh page-one load and the splice is skipped.
  const runParam = url.searchParams.get('run');
  const highlightRunId = runParam && /^\d+$/.test(runParam) ? Number(runParam) : null;
  if (highlightRunId != null && !cursor && !extractionRuns.some((r) => r.id === highlightRunId)) {
    const highlighted = await fetchProjectRunById(db, id, highlightRunId);
    // A missing, foreign, or wrong-kind run id leaves extractionRuns
    // untouched: the page toasts when the raw `?run=` value is not even
    // numeric; a syntactically valid but nonexistent/foreign id keeps the
    // same silent "nothing highlighted" behaviour the campaign page has.
    if (highlighted) {
      extractionRuns = [...extractionRuns, highlighted].sort((a, b) => {
        const diff = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
        return diff !== 0 ? diff : b.id - a.id;
      });
    }
  }
  const latestInsightSerialized = latestInsight
    ? {
        id: latestInsight.id,
        summaryMd: latestInsight.summaryMd,
        evidence: latestInsight.evidence,
        generatedAt:
          latestInsight.generatedAt instanceof Date
            ? latestInsight.generatedAt.toISOString()
            : (latestInsight.generatedAt as unknown as string),
      }
    : null;
  return {
    project,
    accounts,
    platforms,
    extractionRuns,
    extractionRunsTotalCount,
    extractionRunsNextCursor,
    recommendations,
    templates,
    latestInsight: latestInsightSerialized,
  };
};
