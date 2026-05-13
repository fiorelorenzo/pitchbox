import { json, error } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { notify } from '@pitchbox/shared/notifications';
import { enqueueReplyDraft } from '@pitchbox/shared/reply-drafter';
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
type SyncChannelStatus = 'ok' | 'unauthorized' | 'error' | 'unknown';

type IncomingStatus = {
  chat?: SyncChannelStatus;
  legacy?: SyncChannelStatus;
  captured_at?: string;
};

type Body = {
  platform: string;
  items: IncomingDm[];
  comments?: IncomingCommentReply[];
  status?: IncomingStatus;
};

const ALLOWED_STATUS: ReadonlySet<SyncChannelStatus> = new Set([
  'ok',
  'unauthorized',
  'error',
  'unknown',
]);

function normaliseChannel(value: unknown): SyncChannelStatus {
  return typeof value === 'string' && ALLOWED_STATUS.has(value as SyncChannelStatus)
    ? (value as SyncChannelStatus)
    : 'unknown';
}

async function persistDeviceSyncStatus(
  db: ReturnType<typeof getDb>,
  deviceId: number,
  status: IncomingStatus,
): Promise<void> {
  const now = new Date().toISOString();
  const captured =
    typeof status.captured_at === 'string' && !Number.isNaN(Date.parse(status.captured_at))
      ? status.captured_at
      : now;
  const payload = {
    chat: normaliseChannel(status.chat),
    legacy: normaliseChannel(status.legacy),
    captured_at: captured,
    updated_at: now,
  };
  await db
    .update(schema.extensionDevices)
    .set({ lastSyncStatus: payload })
    .where(eq(schema.extensionDevices.id, deviceId));
}

export async function POST({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || !Array.isArray(body.items) || typeof body.platform !== 'string') {
    throw error(400, 'invalid body');
  }

  const db = getDb();

  // Persist liveness payload before anything else so the dashboard banner
  // reacts even when the sync had zero items.
  if (body.status && typeof body.status === 'object') {
    await persistDeviceSyncStatus(db, auth.deviceId, body.status);
  }

  const comments: IncomingCommentReply[] = Array.isArray(body.comments) ? body.comments : [];
  if (body.items.length === 0 && comments.length === 0) {
    return json({ ok: true, inserted: 0, replied: 0, commentsInserted: 0, commentsReplied: 0 });
  }
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
        platformPostId: schema.drafts.platformPostId,
      })
      .from(schema.drafts)
      .where(eq(schema.drafts.platformId, platform.id));
    // Two channels feed the comment matcher with the same shape:
    //   - comment-reply drafts (parent is the t1_ id of our comment)
    //   - reddit-poster drafts (parent is the t3_ id of our submission)
    commentDrafts = draftRows.flatMap((d) => {
      const account = handleByAccountId.get(d.accountId);
      if (!account) return [];
      const rows: CommentDraftRow[] = [];
      if (d.platformCommentId) {
        rows.push({
          draftId: d.draftId,
          platformId: platform.id,
          platformCommentId: d.platformCommentId,
          accountHandle: account,
        });
      }
      if (d.platformPostId) {
        rows.push({
          draftId: d.draftId,
          platformId: platform.id,
          platformCommentId: d.platformPostId,
          accountHandle: account,
        });
      }
      return rows;
    });

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

  // Reply drafting (issue #49). For each draft we just flipped to `replied`,
  // enqueue a continuation draft pointing at the newest inbound message.
  // Failures are non-fatal - the original sync result must still return.
  const insertedKeys = new Set<string>([
    ...inserts.map((i) => `${i.platformId}:${i.platformMessageId}`),
    ...commentMatch.messageInserts.map((m) => `${m.platformId}:${m.platformMessageId}`),
  ]);
  if (insertedKeys.size > 0) {
    const newlyInsertedRows = await db
      .select({
        id: schema.messages.id,
        draftId: schema.messages.draftId,
        platformMessageId: schema.messages.platformMessageId,
        platformId: schema.messages.platformId,
        isFromUs: schema.messages.isFromUs,
      })
      .from(schema.messages)
      .where(eq(schema.messages.platformId, platform.id));
    for (const u of updates) {
      if (u.draftId == null) continue;
      const newest = newlyInsertedRows
        .filter(
          (m) =>
            !m.isFromUs &&
            m.draftId === u.draftId &&
            insertedKeys.has(`${m.platformId}:${m.platformMessageId}`),
        )
        .sort((a, b) => b.id - a.id)[0];
      if (!newest) continue;
      try {
        await enqueueReplyDraft(db, {
          parentDraftId: u.draftId,
          parentMessageId: newest.id,
          replyKind: 'reply_dm',
        });
      } catch {
        // swallow - non-fatal
      }
    }
    for (const ev of commentMatch.draftRepliedEvents) {
      const newest = newlyInsertedRows
        .filter((m) => !m.isFromUs && m.draftId === ev.draftId)
        .sort((a, b) => b.id - a.id)[0];
      if (!newest) continue;
      try {
        await enqueueReplyDraft(db, {
          parentDraftId: ev.draftId,
          parentMessageId: newest.id,
          replyKind: 'reply_comment',
        });
      } catch {
        // swallow - non-fatal
      }
    }
  }

  const repliedCount =
    updates.filter((u) => u.draftId != null).length + commentMatch.draftRepliedEvents.length;
  if (repliedCount > 0) {
    await notify(db, {
      kind: 'reply.received',
      title: `${repliedCount} repl${repliedCount === 1 ? 'y' : 'ies'} received`,
      body: 'New incoming replies have been attached to their drafts.',
      payload: { count: repliedCount },
      severity: 'success',
    });
  }

  return json({
    ok: true,
    inserted: inserts.length,
    replied: updates.length,
    commentsInserted: commentMatch.messageInserts.length,
    commentsReplied: commentMatch.draftRepliedEvents.length,
  });
}
