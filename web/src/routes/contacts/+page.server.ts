import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { requireOrgId } from '$lib/server/auth.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const { url } = event;
  const db = getDb();

  const orgId = await requireOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);
  const hasProjects = projectIds.length > 0;

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

  // contact_history is a global accepted residual (see the
  // organization-isolation design doc), so every contact row stays visible.
  // The attached draft is not: scope the drafts join to the active org's
  // projects so a cross-org draft's kind/run/state never renders - when
  // there is no match (or the org has no projects) the join yields nulls.
  const draftJoinCond = and(
    eq(schema.contactHistory.draftId, schema.drafts.id),
    hasProjects ? inArray(schema.drafts.projectId, projectIds) : sql`false`,
  );

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
    .leftJoin(schema.drafts, draftJoinCond)
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
