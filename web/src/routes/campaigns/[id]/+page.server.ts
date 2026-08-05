import { error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { getCampaignReadiness } from '$lib/server/campaign-readiness.js';
import { desc, eq } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import { campaignBelongsToOrg } from '@pitchbox/shared/orgs';
import {
  enrichCampaignRuns,
  fetchCampaignRunById,
  queryCampaignRunsPage,
  parseCampaignRunsCursor,
} from '$lib/server/campaign-runs-query.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { params, url } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await campaignBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!campaign) throw error(404, 'campaign not found');
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, campaign.projectId));
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.id, campaign.platformId));

  const cursor = parseCampaignRunsCursor(url);
  const { rows: pageRows, totalCount, nextCursor } = await queryCampaignRunsPage(db, id, cursor);

  // A `?run=<id>` deep link (#239) can target a run older than this first
  // page (#259): fetch it out of band and splice it into the rows handed to
  // the Runs tab so it is present and highlightable on first load, rather
  // than hoping the user pages far enough to reach it. Cursor pagination
  // never touches the address bar (the "Load more" fetch builds its own
  // URL - see CampaignRunsTab.svelte), so a non-null cursor here means this
  // is not a fresh page-one load and the splice is skipped.
  const runParam = url.searchParams.get('run');
  const highlightRunId = runParam && /^\d+$/.test(runParam) ? Number(runParam) : null;
  let runsTabRows = pageRows;
  if (highlightRunId != null && !cursor && !pageRows.some((r) => r.id === highlightRunId)) {
    const highlighted = await fetchCampaignRunById(db, id, highlightRunId);
    // A missing or foreign run id leaves runsTabRows untouched: the client
    // already toasts when the raw `?run=` value is not even numeric (#239);
    // a syntactically valid but nonexistent/foreign id keeps the same
    // silent "nothing highlighted" behaviour it had before this fix.
    if (highlighted) {
      runsTabRows = [...pageRows, highlighted].sort((a, b) => {
        const diff = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
        return diff !== 0 ? diff : b.id - a.id;
      });
    }
  }
  const enrichedRuns = await enrichCampaignRuns(db, runsTabRows);

  // skillRuns / tuningRuns are Overview/Tuning tab concerns, not the Runs
  // tab this pagination targets - they stay windowed to this first page,
  // unchanged from before #259.
  const skillRuns = pageRows
    .filter((r) => r.kind === 'campaign_skill_generation')
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      status: r.status,
      params: r.params as { objective?: string } | null,
    }));
  // Tuning runs include the raw run rows (with params.generatedConfig and
  // params.previousConfig) so the Tuning tab can diff before/after.
  const tuningRuns = pageRows
    .filter((r) => r.kind === 'campaign_skill_generation')
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : r.startedAt,
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : r.finishedAt,
      params: r.params as Record<string, unknown> | null,
    }));
  const watches = await db
    .select()
    .from(schema.keywordWatches)
    .where(eq(schema.keywordWatches.campaignId, id))
    .orderBy(desc(schema.keywordWatches.createdAt));
  // Serialize date columns to ISO strings so prop types stay simple across the wire.
  const enrichedWatches = watches.map((w) => ({
    ...w,
    lastSeenAt: w.lastSeenAt ? new Date(w.lastSeenAt).toISOString() : null,
    nextAttemptAfter: w.nextAttemptAfter ? new Date(w.nextAttemptAfter).toISOString() : null,
    createdAt: new Date(w.createdAt).toISOString(),
  }));
  const readiness = await getCampaignReadiness(id);
  return {
    campaign,
    project: project ?? null,
    platform: platform ?? null,
    runs: enrichedRuns,
    runsTotalCount: totalCount,
    runsNextCursor: nextCursor,
    skillRuns,
    tuningRuns,
    watches: enrichedWatches,
    readiness,
  };
};
