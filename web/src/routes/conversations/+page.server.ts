import { getDb, schema } from '$lib/server/db.js';
import { desc, eq, inArray, sql } from 'drizzle-orm';

export async function load() {
  const db = getDb();

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
      subreddit: schema.drafts.subreddit,
      platformContextUrl: schema.contactHistory.platformContextUrl,
    })
    .from(schema.contactHistory)
    .innerJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .leftJoin(schema.drafts, eq(schema.contactHistory.draftId, schema.drafts.id))
    .orderBy(
      sql`coalesce(${schema.contactHistory.repliedAt}, ${schema.contactHistory.lastContactedAt}) desc`,
    )
    .limit(200);

  const contactIds = rows.map((r) => r.contactId);
  const latestByContact = new Map<
    number,
    { body: string; author: string; createdAt: Date; isFromUs: boolean }
  >();
  if (contactIds.length > 0) {
    const msgs = await db
      .select({
        contactId: schema.messages.contactId,
        body: schema.messages.body,
        author: schema.messages.author,
        createdAt: schema.messages.createdAtPlatform,
        isFromUs: schema.messages.isFromUs,
      })
      .from(schema.messages)
      .where(inArray(schema.messages.contactId, contactIds))
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
  };
}
