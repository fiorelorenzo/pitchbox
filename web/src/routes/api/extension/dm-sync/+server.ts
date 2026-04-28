import { json, error } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { matchIncomingDms, type ContactRow, type IncomingDm } from '@pitchbox/shared/dm-sync';
import {
  matchIncomingCommentReplies,
  type CommentDraftRow,
  type CommentReplyContact,
  type IncomingCommentReply,
} from '@pitchbox/shared/comment-sync';

// Invariant: this route never writes `drafts.sent_at`. It records inbound
// messages and flips drafts to `replied`. Quota counts depend on `sent_at`,
// so no over-quota logging happens here. If a future change starts writing
// `sent_at` from this route, also wire `evaluateDraftSend` like the
// /inbox/[id] and /api/extension/draft/[id]/sent routes do.
type Body = {
  platform: string;
  items: IncomingDm[];
  comments?: IncomingCommentReply[];
};

export async function POST({ request }: { request: Request }) {
  await requireExtensionAuth(request);
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || !Array.isArray(body.items) || typeof body.platform !== 'string') {
    throw error(400, 'invalid body');
  }

  const comments: IncomingCommentReply[] = Array.isArray(body.comments) ? body.comments : [];
  if (body.items.length === 0 && comments.length === 0) {
    return json({ ok: true, inserted: 0, replied: 0, commentsInserted: 0, commentsReplied: 0 });
  }

  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, body.platform));
  if (!platform) throw error(404, 'unknown platform');

  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({
      id: schema.contactHistory.id,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      platformId: schema.contactHistory.platformId,
      draftId: schema.contactHistory.draftId,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
    })
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.platformId, platform.id));

  const fresh: ContactRow[] = candidates
    .filter((c) => c.lastContactedAt >= since)
    .map((c) => ({
      id: c.id,
      accountHandle: c.accountHandle,
      targetUser: c.targetUser,
      platformId: c.platformId,
      draftId: c.draftId,
      lastContactedAt: c.lastContactedAt,
      repliedAt: c.repliedAt,
    }));

  const { inserts, updates, roomIdsByContact } = matchIncomingDms(body.items, fresh);

  // Comment-reply path.
  let commentDrafts: CommentDraftRow[] = [];
  let commentExisting: CommentReplyContact[] = [];
  if (comments.length > 0) {
    const accountRows = await db
      .select({ id: schema.accounts.id, handle: schema.accounts.handle })
      .from(schema.accounts)
      .where(eq(schema.accounts.platformId, platform.id));
    const handleByAccountId = new Map(accountRows.map((a) => [a.id, a.handle]));
    const draftRows = await db
      .select({
        draftId: schema.drafts.id,
        accountId: schema.drafts.accountId,
        platformCommentId: schema.drafts.platformCommentId,
      })
      .from(schema.drafts)
      .where(eq(schema.drafts.platformId, platform.id));
    commentDrafts = draftRows
      .filter((d) => d.platformCommentId)
      .map((d) => ({
        draftId: d.draftId,
        platformId: platform.id,
        platformCommentId: d.platformCommentId!,
        accountHandle: handleByAccountId.get(d.accountId) ?? '',
      }))
      .filter((d) => d.accountHandle);

    const draftIds = commentDrafts.map((d) => d.draftId);
    if (draftIds.length > 0) {
      const existingRows = await db
        .select({
          contactId: schema.contactHistory.id,
          accountHandle: schema.contactHistory.accountHandle,
          targetUser: schema.contactHistory.targetUser,
          draftId: schema.contactHistory.draftId,
          repliedAt: schema.contactHistory.repliedAt,
        })
        .from(schema.contactHistory)
        .where(inArray(schema.contactHistory.draftId, draftIds));
      commentExisting = existingRows
        .filter((r) => r.draftId != null)
        .map((r) => ({
          contactId: r.contactId,
          accountHandle: r.accountHandle,
          targetUser: r.targetUser,
          draftId: r.draftId!,
          repliedAt: r.repliedAt,
        }));
    }
  }

  const commentMatch = matchIncomingCommentReplies(comments, commentDrafts, commentExisting);

  if (inserts.length === 0 && commentMatch.messageInserts.length === 0) {
    return json({ ok: true, inserted: 0, replied: 0, commentsInserted: 0, commentsReplied: 0 });
  }

  await db.transaction(async (tx) => {
    for (const row of inserts) {
      await tx
        .insert(schema.messages)
        .values(row)
        .onConflictDoNothing({
          target: [schema.messages.platformId, schema.messages.platformMessageId],
        });
    }
    for (const u of updates) {
      await tx
        .update(schema.contactHistory)
        .set({ repliedAt: u.repliedAt, replyCheckedAt: new Date() })
        .where(eq(schema.contactHistory.id, u.contactId));
      if (u.draftId != null) {
        await tx.insert(schema.draftEvents).values({
          draftId: u.draftId,
          event: 'replied',
          actor: 'extension',
          details: { at: u.repliedAt.toISOString() },
        });
      }
    }
    for (const [contactId, roomId] of roomIdsByContact) {
      await tx
        .update(schema.contactHistory)
        .set({ chatRoomId: roomId })
        .where(eq(schema.contactHistory.id, contactId));
    }

    // Comment-reply path: create new contacts, then insert messages, then mark replied.
    const createdContactIdByKey = new Map<string, number>();
    for (const c of commentMatch.contactsToCreate) {
      const [row] = await tx
        .insert(schema.contactHistory)
        .values({
          platformId: c.platformId,
          accountHandle: c.accountHandle,
          targetUser: c.targetUser,
          lastContactedAt: c.lastContactedAt,
          repliedAt: c.repliedAt,
          replyCheckedAt: new Date(),
          draftId: c.draftId,
          platformContextUrl: c.platformContextUrl,
        })
        .returning({ id: schema.contactHistory.id });
      createdContactIdByKey.set(`${c.accountHandle}::${c.targetUser}::${c.draftId}`, row.id);
    }
    for (const m of commentMatch.messageInserts) {
      let contactId: number;
      if (m.contactKey.kind === 'existing') {
        contactId = m.contactKey.contactId;
      } else {
        const k = `${m.contactKey.accountHandle}::${m.contactKey.targetUser}::${m.contactKey.draftId}`;
        const id = createdContactIdByKey.get(k);
        if (!id) continue; // should not happen
        contactId = id;
      }
      await tx
        .insert(schema.messages)
        .values({
          contactId,
          draftId: m.draftId,
          platformId: m.platformId,
          author: m.author,
          isFromUs: m.isFromUs,
          body: m.body,
          platformMessageId: m.platformMessageId,
          createdAtPlatform: m.createdAtPlatform,
          source: m.source,
        })
        .onConflictDoNothing({
          target: [schema.messages.platformId, schema.messages.platformMessageId],
        });
    }
    for (const ev of commentMatch.draftRepliedEvents) {
      await tx.insert(schema.draftEvents).values({
        draftId: ev.draftId,
        event: 'replied',
        actor: 'extension',
        details: { at: ev.repliedAt.toISOString() },
      });
    }
  });

  const nowIso = new Date().toISOString();
  await db
    .insert(schema.appConfig)
    .values({ key: 'extension_last_dm_sync_at', value: nowIso })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { value: nowIso },
    });

  for (const u of updates) {
    if (u.draftId != null) emit('drafts:changed', { id: u.draftId, state: 'replied' });
  }
  for (const ev of commentMatch.draftRepliedEvents) {
    emit('drafts:changed', { id: ev.draftId, state: 'replied' });
  }

  return json({
    ok: true,
    inserted: inserts.length,
    replied: updates.length,
    commentsInserted: commentMatch.messageInserts.length,
    commentsReplied: commentMatch.draftRepliedEvents.length,
  });
}
