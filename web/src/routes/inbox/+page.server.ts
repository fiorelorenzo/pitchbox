import { getDb, schema } from '$lib/server/db.js';
import { and, eq, desc, inArray, type SQL } from 'drizzle-orm';
import { getUsageForAccounts, loadQuotaLimits } from '@pitchbox/shared/quota';
import { listProjects } from '@pitchbox/shared/projects';

export async function load({ url }: { url: URL }) {
  const state = url.searchParams.get('state') ?? 'pending_review';
  const kind = url.searchParams.get('kind');
  const run = url.searchParams.get('run');
  const campaign = url.searchParams.get('campaign');
  const projectSlug = url.searchParams.get('project') ?? '';
  const db = getDb();

  const projects = await listProjects(db);
  const activeProject = projectSlug
    ? (projects.find((p) => p.slug === projectSlug) ?? null)
    : null;
  const projectsForUi = projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));

  const filters: SQL[] = state !== 'all' ? [eq(schema.drafts.state, state)] : [];
  if (kind) filters.push(eq(schema.drafts.kind, kind));
  if (activeProject) filters.push(eq(schema.drafts.projectId, activeProject.id));

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
      subreddit: schema.drafts.subreddit,
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
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
    })
    .from(schema.drafts)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.drafts.projectId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.drafts.createdAt))
    .limit(200);

  const drafts = draftRows.map(({ projectSlug, projectName, ...rest }) => ({
    ...rest,
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

  if (run) {
    const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, Number(run)));
    if (r) {
      const [c] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, r.campaignId));
      runInfo = { ...r, campaignName: c?.name ?? null };
    }
  }
  if (campaign) {
    const [c] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, Number(campaign)));
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
  };
}
