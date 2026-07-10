import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const db = getDb();

  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);

  // No projects in this org - nothing to show, and `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) {
    return {
      stats: {
        pending: 0,
        approved: 0,
        sent: 0,
        rejected: 0,
        total: 0,
        sentToday: 0,
        createdToday: 0,
        uniqueContacts: 0,
        replies: 0,
      },
      runStats7d: {
        total: 0,
        success: 0,
        failed: 0,
        running: 0,
      },
      recentRuns: [],
      campaigns: [],
      spend: { cost24h: 0, cost7d: 0 },
    };
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // ----- Draft counts (single scan) -----
  const [draftCountsRow] = await db
    .select({
      pending: sql<number>`COUNT(*) FILTER (WHERE state = 'pending_review')::int`,
      approved: sql<number>`COUNT(*) FILTER (WHERE state = 'approved')::int`,
      sent: sql<number>`COUNT(*) FILTER (WHERE state = 'sent')::int`,
      rejected: sql<number>`COUNT(*) FILTER (WHERE state = 'rejected')::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(schema.drafts)
    .where(inArray(schema.drafts.projectId, projectIds));

  const [sentTodayRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.state, 'sent'),
        gte(schema.drafts.sentAt, since24h),
        inArray(schema.drafts.projectId, projectIds),
      ),
    );

  const [createdTodayRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(
      and(gte(schema.drafts.createdAt, since24h), inArray(schema.drafts.projectId, projectIds)),
    );

  // ----- Contacts -----
  // contact_history has no project_id of its own; every real row is created
  // with a draft_id (see inbox/[id], extension dm-sync, extension sent
  // routes), so join through drafts to scope to the org's projects.
  const [contactsRow] = await db
    .select({
      unique: sql<number>`COUNT(DISTINCT (${schema.contactHistory.platformId}, ${schema.contactHistory.targetUser}))::int`,
      replied: sql<number>`COUNT(*) FILTER (WHERE ${schema.contactHistory.repliedAt} IS NOT NULL)::int`,
    })
    .from(schema.contactHistory)
    .innerJoin(schema.drafts, eq(schema.drafts.id, schema.contactHistory.draftId))
    .where(inArray(schema.drafts.projectId, projectIds));

  // ----- Recent runs (campaign runs only - the widget is labelled
  // 'Last 5 campaign runs' so project_extraction / skill_generation runs
  // are filtered out here). -----
  const recentRuns = await db
    .select({
      id: schema.runs.id,
      campaignId: schema.runs.campaignId,
      agentRunner: schema.runs.agentRunner,
      status: schema.runs.status,
      trigger: schema.runs.trigger,
      startedAt: schema.runs.startedAt,
      finishedAt: schema.runs.finishedAt,
      tokensUsed: schema.runs.tokensUsed,
      campaignName: schema.campaigns.name,
    })
    .from(schema.runs)
    .innerJoin(schema.campaigns, eq(schema.runs.campaignId, schema.campaigns.id))
    .where(and(eq(schema.runs.kind, 'campaign'), inArray(schema.runs.projectId, projectIds)))
    .orderBy(desc(schema.runs.startedAt))
    .limit(5);

  // ----- Spend (last 24h / 7d) -----
  const [spendRow] = await db
    .select({
      cost24h: sql<
        string | null
      >`COALESCE(SUM(cost_usd) FILTER (WHERE started_at >= ${since24h}), 0)`,
      cost7d: sql<
        string | null
      >`COALESCE(SUM(cost_usd) FILTER (WHERE started_at >= ${since7d}), 0)`,
    })
    .from(schema.runs)
    .where(inArray(schema.runs.projectId, projectIds));
  const spend = {
    cost24h: Number(spendRow?.cost24h ?? 0),
    cost7d: Number(spendRow?.cost7d ?? 0),
  };

  // ----- Run stats (last 7 days, campaign runs only - the three cards on
  // the home page are labelled 'Campaign runs', 'Successful runs',
  // 'Failed runs' and are about outreach activity, not extraction /
  // skill-generation runs). -----
  const [runStats7d] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      success: sql<number>`COUNT(*) FILTER (WHERE status = 'success')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE status IN ('failed','error','cancelled'))::int`,
      running: sql<number>`COUNT(*) FILTER (WHERE status = 'running')::int`,
    })
    .from(schema.runs)
    .where(
      and(
        gte(schema.runs.startedAt, since7d),
        eq(schema.runs.kind, 'campaign'),
        inArray(schema.runs.projectId, projectIds),
      ),
    );

  // ----- Campaigns with derived last-run info -----
  // Derive from runs table so we don't depend on campaigns.last_run_at, which is
  // only kept fresh by the scheduler (manual "Run now" leaves it stale).
  const campaignsRaw = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      status: schema.campaigns.status,
      platformId: schema.campaigns.platformId,
    })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.projectId, projectIds));

  const allRuns = await db
    .select({
      id: schema.runs.id,
      campaignId: schema.runs.campaignId,
      status: schema.runs.status,
      startedAt: schema.runs.startedAt,
    })
    .from(schema.runs)
    .where(and(isNotNull(schema.runs.campaignId), inArray(schema.runs.projectId, projectIds)))
    .orderBy(desc(schema.runs.startedAt));

  const latestRunByCampaign = new Map<number, (typeof allRuns)[number]>();
  const runningByCampaign = new Set<number>();
  for (const r of allRuns) {
    if (r.campaignId == null) continue;
    if (r.status === 'running') runningByCampaign.add(r.campaignId);
    if (!latestRunByCampaign.has(r.campaignId)) latestRunByCampaign.set(r.campaignId, r);
  }

  const campaigns = campaignsRaw
    .map((c) => {
      const lr = latestRunByCampaign.get(c.id) ?? null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        platformId: c.platformId,
        lastRunId: lr?.id ?? null,
        lastRunStatus: lr?.status ?? null,
        lastRunStartedAt: lr?.startedAt ?? null,
        isRunning: runningByCampaign.has(c.id),
      };
    })
    .sort((a, b) => {
      const ta = a.lastRunStartedAt ? new Date(a.lastRunStartedAt).getTime() : 0;
      const tb = b.lastRunStartedAt ? new Date(b.lastRunStartedAt).getTime() : 0;
      return tb - ta;
    });

  return {
    stats: {
      pending: draftCountsRow?.pending ?? 0,
      approved: draftCountsRow?.approved ?? 0,
      sent: draftCountsRow?.sent ?? 0,
      rejected: draftCountsRow?.rejected ?? 0,
      total: draftCountsRow?.total ?? 0,
      sentToday: sentTodayRow?.count ?? 0,
      createdToday: createdTodayRow?.count ?? 0,
      uniqueContacts: contactsRow?.unique ?? 0,
      replies: contactsRow?.replied ?? 0,
    },
    runStats7d: {
      total: runStats7d?.total ?? 0,
      success: runStats7d?.success ?? 0,
      failed: runStats7d?.failed ?? 0,
      running: runStats7d?.running ?? 0,
    },
    recentRuns,
    campaigns,
    spend,
  };
}
