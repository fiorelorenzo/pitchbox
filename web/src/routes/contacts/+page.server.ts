import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, ilike, sql, type SQL } from 'drizzle-orm';

export async function load({ url }: { url: URL }) {
  const db = getDb();

  const platform = url.searchParams.get('platform');
  const query = url.searchParams.get('q')?.trim();

  const platforms = await db.select().from(schema.platforms).orderBy(schema.platforms.slug);

  const filters: SQL[] = [];
  if (platform) {
    const match = platforms.find((p) => p.slug === platform);
    if (match) filters.push(eq(schema.contactHistory.platformId, match.id));
  }
  if (query) {
    filters.push(ilike(schema.contactHistory.targetUser, `%${query}%`));
  }

  const contacts = await db
    .select({
      id: schema.contactHistory.id,
      platformId: schema.contactHistory.platformId,
      platformSlug: schema.platforms.slug,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
      replyCheckedAt: schema.contactHistory.replyCheckedAt,
      draftId: schema.contactHistory.draftId,
      draftKind: schema.drafts.kind,
      draftRunId: schema.drafts.runId,
      draftState: schema.drafts.state,
    })
    .from(schema.contactHistory)
    .leftJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .leftJoin(schema.drafts, eq(schema.contactHistory.draftId, schema.drafts.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.contactHistory.lastContactedAt))
    .limit(500);

  const [totalRow] = await db
    .select({
      unique: sql<number>`COUNT(DISTINCT (platform_id, target_user))::int`,
      total: sql<number>`COUNT(*)::int`,
      replied: sql<number>`COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
    })
    .from(schema.contactHistory);

  return {
    contacts,
    platforms,
    filters: {
      platform: platform ?? null,
      q: query ?? '',
    },
    totals: {
      unique: totalRow?.unique ?? 0,
      total: totalRow?.total ?? 0,
      replied: totalRow?.replied ?? 0,
    },
  };
}
