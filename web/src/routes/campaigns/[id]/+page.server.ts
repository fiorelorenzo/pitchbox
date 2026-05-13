import { error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { getCampaignReadiness } from '$lib/server/campaign-readiness.js';
import { desc, eq, count, inArray } from 'drizzle-orm';

export async function load({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
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
  const runs = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.campaignId, id))
    .orderBy(desc(schema.runs.startedAt))
    .limit(30);
  // Only count drafts for regular campaign runs - skill-generation runs never produce drafts.
  const campaignRunIds = runs.filter((r) => r.kind === 'campaign').map((r) => r.id);
  const draftCounts =
    campaignRunIds.length > 0
      ? await db
          .select({ runId: schema.drafts.runId, n: count() })
          .from(schema.drafts)
          .where(inArray(schema.drafts.runId, campaignRunIds))
          .groupBy(schema.drafts.runId)
      : [];
  const draftsByRun = new Map(draftCounts.map((d) => [d.runId, Number(d.n)]));
  const enrichedRuns = runs.map((r) => ({
    ...r,
    // Serialize date columns to ISO strings so prop types stay simple across the wire.
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : r.startedAt,
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : r.finishedAt,
    draftCount: r.kind === 'campaign' ? (draftsByRun.get(r.id) ?? 0) : 0,
    durationMs:
      r.finishedAt && r.startedAt
        ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
        : null,
  }));
  const skillRuns = enrichedRuns.filter((r) => r.kind === 'campaign_skill_generation').slice(0, 5);
  // Tuning runs include the raw run rows (with params.generatedConfig and
  // params.previousConfig) so the Tuning tab can diff before/after.
  const tuningRunsRaw = runs.filter((r) => r.kind === 'campaign_skill_generation').slice(0, 20);
  const tuningRuns = tuningRunsRaw.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : r.startedAt,
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : r.finishedAt,
    params: r.params as Record<string, unknown> | null,
  }));
  const readiness = await getCampaignReadiness(id);
  return {
    campaign,
    project: project ?? null,
    platform: platform ?? null,
    runs: enrichedRuns,
    skillRuns,
    tuningRuns,
    readiness,
  };
}
