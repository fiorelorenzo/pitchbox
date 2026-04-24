import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

export async function load() {
  const db = getDb();

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
    .from(schema.drafts);

  const [sentTodayRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.state, 'sent'), gte(schema.drafts.sentAt, since24h)));

  const [createdTodayRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.drafts)
    .where(gte(schema.drafts.createdAt, since24h));

  // ----- Contacts -----
  const [contactsRow] = await db
    .select({
      unique: sql<number>`COUNT(DISTINCT (platform_id, target_user))::int`,
      replied: sql<number>`COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
    })
    .from(schema.contactHistory);

  // ----- Recent runs -----
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
    .leftJoin(schema.campaigns, eq(schema.runs.campaignId, schema.campaigns.id))
    .orderBy(desc(schema.runs.startedAt))
    .limit(5);

  // ----- Run stats (last 7 days) -----
  const [runStats7d] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      success: sql<number>`COUNT(*) FILTER (WHERE status = 'success')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE status IN ('failed','error','cancelled'))::int`,
      running: sql<number>`COUNT(*) FILTER (WHERE status = 'running')::int`,
    })
    .from(schema.runs)
    .where(gte(schema.runs.startedAt, since7d));

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
    .from(schema.campaigns);

  const allRuns = await db
    .select({
      id: schema.runs.id,
      campaignId: schema.runs.campaignId,
      status: schema.runs.status,
      startedAt: schema.runs.startedAt,
    })
    .from(schema.runs)
    .orderBy(desc(schema.runs.startedAt));

  const latestRunByCampaign = new Map<number, (typeof allRuns)[number]>();
  const runningByCampaign = new Set<number>();
  for (const r of allRuns) {
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
  };
}
