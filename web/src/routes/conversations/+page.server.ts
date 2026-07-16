import { getDb, schema } from '$lib/server/db.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { listProjects } from '@pitchbox/shared/projects';
import { resolveOrgId } from '$lib/server/auth.js';
import { hasChatUnauthorizedDevice } from '$lib/server/extension-sync.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const db = getDb();
  const chatSyncUnauthorized = await hasChatUnauthorizedDevice();

  const orgId = await resolveOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);
  const hasProjects = projectIds.length > 0;

  // contact_history is a global accepted residual (see the
  // organization-isolation design doc), so every contact row stays visible.
  // The attached draft is not: scope the drafts join to the active org's
  // projects so a cross-org draft's kind/state/body/metadata never renders -
  // when there is no match (or the org has no projects) the join yields nulls.
  const draftJoinCond = and(
    eq(schema.contactHistory.draftId, schema.drafts.id),
    hasProjects ? inArray(schema.drafts.projectId, projectIds) : sql`false`,
  );

  const rows = await db
    .select({
      contactId: schema.contactHistory.id,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      platformSlug: schema.platforms.slug,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
      chatRoomId: schema.contactHistory.chatRoomId,
      draftId: schema.contactHistory.draftId,
      draftKind: schema.drafts.kind,
      draftState: schema.drafts.state,
      draftBody: schema.drafts.body,
      draftMetadata: schema.drafts.metadata,
      platformContextUrl: schema.contactHistory.platformContextUrl,
    })
    .from(schema.contactHistory)
    .innerJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .leftJoin(schema.drafts, draftJoinCond)
    .orderBy(
      sql`coalesce(${schema.contactHistory.repliedAt}, ${schema.contactHistory.lastContactedAt}) desc`,
    )
    .limit(200);

  const contactIds = rows.map((r) => r.contactId);
  const latestByContact = new Map<
    number,
    { body: string; author: string; createdAt: Date; isFromUs: boolean }
  >();
  // Messages are attributed to an org through the draft they were matched to
  // (drafts.projectId); a message with no draftId cannot be attributed to any
  // org, so it is excluded rather than risk showing it across tenants.
  if (contactIds.length > 0 && hasProjects) {
    const msgs = await db
      .select({
        contactId: schema.messages.contactId,
        body: schema.messages.body,
        author: schema.messages.author,
        createdAt: schema.messages.createdAtPlatform,
        isFromUs: schema.messages.isFromUs,
      })
      .from(schema.messages)
      .innerJoin(schema.drafts, eq(schema.messages.draftId, schema.drafts.id))
      .where(
        and(
          inArray(schema.messages.contactId, contactIds),
          inArray(schema.drafts.projectId, projectIds),
        ),
      )
      .orderBy(desc(schema.messages.createdAtPlatform));
    for (const m of msgs) {
      if (!latestByContact.has(m.contactId)) latestByContact.set(m.contactId, m);
    }
  }

  return {
    conversations: rows.map((r) => ({
      ...r,
      lastMessage: latestByContact.get(r.contactId) ?? null,
    })),
    chatSyncUnauthorized,
  };
}
