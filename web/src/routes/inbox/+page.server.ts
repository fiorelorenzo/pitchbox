import { getDb, schema } from '$lib/server/db.js';
import { and, eq, desc, gte, inArray, type SQL } from 'drizzle-orm';
import { getUsageForAccounts, loadQuotaLimits } from '@pitchbox/shared/quota';
import { listProjects } from '@pitchbox/shared/projects';
import { loadQualityRubric } from '@pitchbox/shared/quality-judge';
import { runBelongsToOrg } from '@pitchbox/shared/orgs';
import { resolveOrgId } from '$lib/server/auth.js';
import { hasChatUnauthorizedDevice } from '$lib/server/extension-sync.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const { url } = event;
  const state = url.searchParams.get('state') ?? 'pending_review';
  const kind = url.searchParams.get('kind');
  const run = url.searchParams.get('run');
  const campaign = url.searchParams.get('campaign');
  const projectSlug = url.searchParams.get('project') ?? '';
  const platformSlugFilter = url.searchParams.get('platform');
  const minQualityRaw = url.searchParams.get('minQuality');
  const minQuality =
    minQualityRaw != null && minQualityRaw !== '' && Number.isFinite(Number(minQualityRaw))
      ? Math.max(0, Math.min(100, Number(minQualityRaw)))
      : null;
  const db = getDb();
  const qualityRubric = await loadQualityRubric(db);

  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const chatSyncUnauthorized = await hasChatUnauthorizedDevice();
  const activeProject = projectSlug ? (projects.find((p) => p.slug === projectSlug) ?? null) : null;
  const projectsForUi = projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
  const projectIds = projects.map((p) => p.id);

  const allPlatforms = await db
    .select({ id: schema.platforms.id, slug: schema.platforms.slug })
    .from(schema.platforms);
  const activePlatform = platformSlugFilter
    ? (allPlatforms.find((p) => p.slug === platformSlugFilter) ?? null)
    : null;

  // No projects in this org - render an empty inbox. `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return {
      drafts: [],
      state,
      kind,
      run: null,
      campaign,
      runInfo: null,
      campaignInfo: null,
      usage: {},
      quotaLimitsByPlatform: {},
      projects: projectsForUi,
      activeProject,
      platforms: allPlatforms,
      activePlatform,
      chatSyncUnauthorized,
      qualityRubric,
    };
  }

  if (platformSlugFilter && !activePlatform) {
    return {
      drafts: [],
      state,
      kind,
      run: null,
      campaign,
      runInfo: null,
      campaignInfo: null,
      usage: {},
      quotaLimitsByPlatform: {},
      projects: projectsForUi,
      activeProject,
      platforms: allPlatforms,
      activePlatform: null,
      chatSyncUnauthorized,
      qualityRubric,
    };
  }

  // Mandatory org scope - applies even with no project selected.
  const filters: SQL[] = [inArray(schema.drafts.projectId, projectIds)];
  if (state !== 'all') filters.push(eq(schema.drafts.state, state));
  if (kind) filters.push(eq(schema.drafts.kind, kind));
  if (activeProject) filters.push(eq(schema.drafts.projectId, activeProject.id));
  if (activePlatform) filters.push(eq(schema.drafts.platformId, activePlatform.id));
  if (minQuality != null) filters.push(gte(schema.drafts.qualityScore, minQuality));

  if (run) {
    filters.push(eq(schema.drafts.runId, Number(run)));
  } else if (campaign) {
    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.campaignId, Number(campaign)));
    if (runs.length === 0) {
      return {
        drafts: [],
        state,
        kind,
        run: null,
        campaign,
        runInfo: null,
        campaignInfo: null,
        usage: {},
        quotaLimitsByPlatform: {},
        projects: projectsForUi,
        activeProject,
        platforms: allPlatforms,
        activePlatform,
        chatSyncUnauthorized,
        qualityRubric,
      };
    }
    filters.push(
      inArray(
        schema.drafts.runId,
        runs.map((r) => r.id),
      ),
    );
  }

  // JOIN projects. Enumerate every draft column explicitly so the page does not lose data.
  const draftRows = await db
    .select({
      id: schema.drafts.id,
      runId: schema.drafts.runId,
      projectId: schema.drafts.projectId,
      platformId: schema.drafts.platformId,
      accountId: schema.drafts.accountId,
      kind: schema.drafts.kind,
      state: schema.drafts.state,
      fitScore: schema.drafts.fitScore,
      targetUser: schema.drafts.targetUser,
      sourceRef: schema.drafts.sourceRef,
      title: schema.drafts.title,
      body: schema.drafts.body,
      composeUrl: schema.drafts.composeUrl,
      reasoning: schema.drafts.reasoning,
      metadata: schema.drafts.metadata,
      createdAt: schema.drafts.createdAt,
      reviewedAt: schema.drafts.reviewedAt,
      sentAt: schema.drafts.sentAt,
      sentContent: schema.drafts.sentContent,
      platformCommentId: schema.drafts.platformCommentId,
      dedupWarning: schema.drafts.dedupWarning,
      qualityScore: schema.drafts.qualityScore,
      qualityReason: schema.drafts.qualityReason,
      variantGroupId: schema.drafts.variantGroupId,
      variantLabel: schema.drafts.variantLabel,
      regenerationCount: schema.drafts.regenerationCount,
      regeneratingRunId: schema.drafts.regeneratingRunId,
      draftingRunId: schema.drafts.draftingRunId,
      draftingRunStatus: schema.runs.status,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
      platformSlug: schema.platforms.slug,
    })
    .from(schema.drafts)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
    .innerJoin(schema.platforms, eq(schema.platforms.id, schema.drafts.platformId))
    .leftJoin(schema.runs, eq(schema.runs.id, schema.drafts.draftingRunId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.drafts.createdAt))
    .limit(200);

  const drafts = draftRows.map(({ projectSlug, projectName, platformSlug, ...rest }) => ({
    ...rest,
    platformSlug,
    project: { id: rest.projectId, slug: projectSlug, name: projectName },
  }));

  const accountIds = Array.from(new Set(drafts.map((d) => d.accountId)));
  const platformIds = Array.from(new Set(drafts.map((d) => d.platformId)));
  const usage = accountIds.length > 0 ? await getUsageForAccounts(db, accountIds) : {};

  const quotaLimitsByPlatform: Record<number, Awaited<ReturnType<typeof loadQuotaLimits>>> = {};
  if (platformIds.length > 0) {
    const rows = await db
      .select({ id: schema.platforms.id, slug: schema.platforms.slug })
      .from(schema.platforms)
      .where(inArray(schema.platforms.id, platformIds));
    for (const row of rows) {
      quotaLimitsByPlatform[row.id] = await loadQuotaLimits(db, row.slug);
    }
  }

  let runInfo: {
    id: number;
    campaignId: number;
    status: string;
    startedAt: Date;
    campaignName: string | null;
  } | null = null;
  let campaignInfo: { id: number; name: string } | null = null;

  if (run && orgId != null) {
    // A run-scoped `inArray(runs.projectId, projectIds)` filter misses every
    // kind:'campaign' run (runs.projectId is NULL for those - the project
    // lives on runs.campaignId -> campaigns.projectId instead), so gate this
    // by-id lookup with the helper that already matches both paths instead.
    const runId = Number(run);
    if (await runBelongsToOrg(db, runId, orgId)) {
      const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (r && r.campaignId != null) {
        const [c] = await db
          .select()
          .from(schema.campaigns)
          .where(eq(schema.campaigns.id, r.campaignId));
        runInfo = {
          id: r.id,
          campaignId: r.campaignId,
          status: r.status,
          startedAt: r.startedAt,
          campaignName: c?.name ?? null,
        };
      }
    }
  }
  if (campaign) {
    const [c] = await db
      .select()
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.id, Number(campaign)),
          inArray(schema.campaigns.projectId, projectIds),
        ),
      );
    if (c) campaignInfo = c;
  }

  return {
    drafts,
    state,
    kind,
    run,
    campaign,
    runInfo,
    campaignInfo,
    usage,
    quotaLimitsByPlatform,
    projects: projectsForUi,
    activeProject,
    platforms: allPlatforms,
    activePlatform,
    chatSyncUnauthorized,
    qualityRubric,
  };
}
