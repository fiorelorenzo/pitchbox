import { getDb, schema } from '$lib/server/db.js';
import { desc, inArray, sql } from 'drizzle-orm';

export async function load() {
  const db = getDb();

  // Fetch campaigns
  const campaigns = await db.select().from(schema.campaigns);

  // Fetch the most recent run per campaign + running state
  // We do a single query: latest run for each campaign, plus draft count, plus isRunning flag
  const latestRuns = await db
    .select({
      campaignId: schema.runs.campaignId,
      id: schema.runs.id,
      status: schema.runs.status,
      startedAt: schema.runs.startedAt,
      finishedAt: schema.runs.finishedAt,
      tokensUsed: schema.runs.tokensUsed,
    })
    .from(schema.runs)
    .orderBy(desc(schema.runs.startedAt));

  // Build a map: campaignId → latest run
  const latestRunByCampaign = new Map<number, (typeof latestRuns)[0]>();
  const runningByCampaign = new Set<number>();

  for (const run of latestRuns) {
    if (run.status === 'running') {
      runningByCampaign.add(run.campaignId);
    }
    if (!latestRunByCampaign.has(run.campaignId)) {
      latestRunByCampaign.set(run.campaignId, run);
    }
  }

  // Fetch draft counts per run for the latest runs
  const latestRunIds = [...latestRunByCampaign.values()].map((r) => r.id);
  const draftCounts: Record<number, number> = {};

  if (latestRunIds.length > 0) {
    const counts = await db
      .select({
        runId: schema.drafts.runId,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(schema.drafts)
      .where(inArray(schema.drafts.runId, latestRunIds))
      .groupBy(schema.drafts.runId);

    for (const row of counts) {
      draftCounts[row.runId] = row.count;
    }
  }

  // Enrich campaigns
  const enrichedCampaigns = campaigns.map((c) => {
    const latestRun = latestRunByCampaign.get(c.id) ?? null;
    const isRunning = runningByCampaign.has(c.id);
    const draftCount = latestRun ? (draftCounts[latestRun.id] ?? 0) : 0;
    const durationMs =
      latestRun?.startedAt && latestRun?.finishedAt
        ? new Date(latestRun.finishedAt).getTime() - new Date(latestRun.startedAt).getTime()
        : null;

    return {
      ...c,
      isRunning,
      lastRunId: latestRun?.id ?? null,
      lastRunStatus: latestRun?.status ?? null,
      lastRunStartedAt: latestRun?.startedAt ?? null,
      lastRunFinishedAt: latestRun?.finishedAt ?? null,
      lastRunDurationMs: durationMs,
      lastRunTokens: latestRun?.tokensUsed ?? null,
      lastRunDraftCount: draftCount,
    };
  });

  return { campaigns: enrichedCampaigns };
}
