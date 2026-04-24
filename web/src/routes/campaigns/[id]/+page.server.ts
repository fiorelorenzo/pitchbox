import { error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
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
  const runIds = runs.map((r) => r.id);
  const draftCounts =
    runIds.length > 0
      ? await db
          .select({ runId: schema.drafts.runId, n: count() })
          .from(schema.drafts)
          .where(inArray(schema.drafts.runId, runIds))
          .groupBy(schema.drafts.runId)
      : [];
  const draftsByRun = new Map(draftCounts.map((d) => [d.runId, Number(d.n)]));
  const enrichedRuns = runs.map((r) => ({
    ...r,
    draftCount: draftsByRun.get(r.id) ?? 0,
    durationMs:
      r.finishedAt && r.startedAt
        ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
        : null,
  }));
  return { campaign, project: project ?? null, platform: platform ?? null, runs: enrichedRuns };
}
