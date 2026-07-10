import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const { url } = event;
  const db = getDb();
  const projectSlug = url.searchParams.get('project') ?? '';

  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const activeProject = projectSlug ? (projects.find((p) => p.slug === projectSlug) ?? null) : null;
  const projectIds = projects.map((p) => p.id);

  // No projects in this org - nothing to show, and `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return { campaigns: [], projects: [], activeProject: null };
  }

  const campaignScope = activeProject
    ? eq(schema.campaigns.projectId, activeProject.id)
    : inArray(schema.campaigns.projectId, projectIds);

  const campaignRows = await db
    .select({
      id: schema.campaigns.id,
      projectId: schema.campaigns.projectId,
      platformId: schema.campaigns.platformId,
      name: schema.campaigns.name,
      skillSlug: schema.campaigns.skillSlug,
      agentRunner: schema.campaigns.agentRunner,
      config: schema.campaigns.config,
      cronExpression: schema.campaigns.cronExpression,
      rateLimit: schema.campaigns.rateLimit,
      status: schema.campaigns.status,
      lastRunAt: schema.campaigns.lastRunAt,
      nextRunAt: schema.campaigns.nextRunAt,
      consecutiveFailures: schema.campaigns.consecutiveFailures,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
      platformSlug: schema.platforms.slug,
    })
    .from(schema.campaigns)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.campaigns.projectId))
    .innerJoin(schema.platforms, eq(schema.platforms.id, schema.campaigns.platformId))
    .where(campaignScope);

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
    .where(and(isNotNull(schema.runs.campaignId), inArray(schema.runs.projectId, projectIds)))
    .orderBy(desc(schema.runs.startedAt));

  const latestRunByCampaign = new Map<number, (typeof latestRuns)[0]>();
  const runningByCampaign = new Set<number>();

  for (const run of latestRuns) {
    if (run.campaignId == null) continue;
    if (run.status === 'running') runningByCampaign.add(run.campaignId);
    if (!latestRunByCampaign.has(run.campaignId)) latestRunByCampaign.set(run.campaignId, run);
  }

  const latestRunIds = [...latestRunByCampaign.values()].map((r) => r.id);
  const draftCounts: Record<number, number> = {};
  if (latestRunIds.length > 0) {
    const counts = await db
      .select({
        runId: schema.drafts.runId,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(schema.drafts)
      .where(
        and(
          inArray(schema.drafts.runId, latestRunIds),
          inArray(schema.drafts.projectId, projectIds),
        ),
      )
      .groupBy(schema.drafts.runId);
    for (const row of counts) draftCounts[row.runId] = row.count;
  }

  const enrichedCampaigns = campaignRows.map((c) => {
    const latestRun = latestRunByCampaign.get(c.id) ?? null;
    const isRunning = runningByCampaign.has(c.id);
    const draftCount = latestRun ? (draftCounts[latestRun.id] ?? 0) : 0;
    const durationMs =
      latestRun?.startedAt && latestRun?.finishedAt
        ? new Date(latestRun.finishedAt).getTime() - new Date(latestRun.startedAt).getTime()
        : null;

    return {
      id: c.id,
      projectId: c.projectId,
      platformId: c.platformId,
      name: c.name,
      skillSlug: c.skillSlug,
      agentRunner: c.agentRunner,
      config: c.config,
      cronExpression: c.cronExpression,
      rateLimit: c.rateLimit,
      status: c.status,
      lastRunAt: c.lastRunAt,
      nextRunAt: c.nextRunAt,
      consecutiveFailures: c.consecutiveFailures,
      project: { id: c.projectId, slug: c.projectSlug, name: c.projectName },
      platformSlug: c.platformSlug,
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

  return {
    campaigns: enrichedCampaigns,
    projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
    activeProject,
  };
}
