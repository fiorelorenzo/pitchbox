import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

export async function load() {
  const db = getDb();

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

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

  const [contactsRow] = await db
    .select({
      unique: sql<number>`COUNT(DISTINCT (platform_id, target_user))::int`,
      replied: sql<number>`COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
    })
    .from(schema.contactHistory);

  const recentRuns = await db
    .select({
      id: schema.runs.id,
      campaignId: schema.runs.campaignId,
      agentRunner: schema.runs.agentRunner,
      status: schema.runs.status,
      trigger: schema.runs.trigger,
      startedAt: schema.runs.startedAt,
      finishedAt: schema.runs.finishedAt,
      campaignName: schema.campaigns.name,
    })
    .from(schema.runs)
    .leftJoin(schema.campaigns, eq(schema.runs.campaignId, schema.campaigns.id))
    .orderBy(desc(schema.runs.startedAt))
    .limit(5);

  const campaigns = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      status: schema.campaigns.status,
      platformId: schema.campaigns.platformId,
      lastRunAt: schema.campaigns.lastRunAt,
      nextRunAt: schema.campaigns.nextRunAt,
    })
    .from(schema.campaigns)
    .orderBy(desc(schema.campaigns.lastRunAt));

  return {
    stats: {
      pending: draftCountsRow?.pending ?? 0,
      approved: draftCountsRow?.approved ?? 0,
      sent: draftCountsRow?.sent ?? 0,
      rejected: draftCountsRow?.rejected ?? 0,
      total: draftCountsRow?.total ?? 0,
      sentToday: sentTodayRow?.count ?? 0,
      uniqueContacts: contactsRow?.unique ?? 0,
      replies: contactsRow?.replied ?? 0,
    },
    recentRuns,
    campaigns,
  };
}
