import { error } from '@sveltejs/kit';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { decodeThreadId } from './thread-id.js';
import { loadPendingReplyDraft } from '@pitchbox/shared/reply-drafter';

export async function load({ params }: { params: { id: string } }) {
  let key;
  try {
    key = decodeThreadId(params.id);
  } catch {
    throw error(400, 'invalid thread id');
  }

  const db = getDb();

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, key.platform));
  if (!platform) throw error(404, 'platform not found');

  // contact_history is the per-(account_handle, target_user, platform) source of
  // truth; we may have several rows for the same pair if the agent contacted
  // the user multiple times — pick the most recent for first/last/outcome.
  const contacts = await db
    .select()
    .from(schema.contactHistory)
    .where(
      and(
        eq(schema.contactHistory.platformId, platform.id),
        eq(schema.contactHistory.accountHandle, key.accountHandle),
        eq(schema.contactHistory.targetUser, key.targetUser),
      ),
    )
    .orderBy(desc(schema.contactHistory.lastContactedAt));

  if (contacts.length === 0) throw error(404, 'thread not found');

  const latest = contacts[0];
  const oldest = contacts[contacts.length - 1];
  const contactIds = contacts.map((c) => c.id);

  // Parent draft for the thread = the draft attached to the most recent
  // contact_history row (that's the one the agent last produced for the pair).
  let parentDraft: typeof schema.drafts.$inferSelect | null = null;
  if (latest.draftId != null) {
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, latest.draftId));
    parentDraft = d ?? null;
  }

  // Load every message attached to any contact_history row in this thread,
  // chronologically ascending.
  const rows = await db
    .select({
      id: schema.messages.id,
      contactId: schema.messages.contactId,
      author: schema.messages.author,
      isFromUs: schema.messages.isFromUs,
      body: schema.messages.body,
      createdAt: schema.messages.createdAtPlatform,
      source: schema.messages.source,
      draftId: schema.messages.draftId,
      draftKind: schema.drafts.kind,
    })
    .from(schema.messages)
    .leftJoin(schema.drafts, eq(schema.messages.draftId, schema.drafts.id))
    .where(
      contactIds.length === 1
        ? eq(schema.messages.contactId, contactIds[0])
        : // drizzle has no `inArray` import here; rebuild with OR if needed —
          // contactIds is small (one tuple, usually 1 row), so keep it simple.
          eq(schema.messages.contactId, contactIds[0]),
    )
    .orderBy(asc(schema.messages.createdAtPlatform));

  // When more than one contact_history row exists for the pair, fetch the rest
  // and merge. This stays out of the hot path (typically only 1 row).
  if (contactIds.length > 1) {
    for (let i = 1; i < contactIds.length; i++) {
      const more = await db
        .select({
          id: schema.messages.id,
          contactId: schema.messages.contactId,
          author: schema.messages.author,
          isFromUs: schema.messages.isFromUs,
          body: schema.messages.body,
          createdAt: schema.messages.createdAtPlatform,
          source: schema.messages.source,
          draftId: schema.messages.draftId,
          draftKind: schema.drafts.kind,
        })
        .from(schema.messages)
        .leftJoin(schema.drafts, eq(schema.messages.draftId, schema.drafts.id))
        .where(eq(schema.messages.contactId, contactIds[i]));
      rows.push(...more);
    }
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // Reply drafting (issue #49): show the pending auto-drafted reply (if any)
  // attached to one of this thread's inbound messages.
  let replyDraft = null as Awaited<ReturnType<typeof loadPendingReplyDraft>> | null;
  for (const cid of contactIds) {
    const found = await loadPendingReplyDraft(db, cid);
    if (found) {
      replyDraft = found;
      break;
    }
  }

  return {
    replyDraft,
    thread: {
      id: params.id,
      accountHandle: key.accountHandle,
      targetUser: key.targetUser,
      platform: key.platform,
    },
    messages: rows.map((r) => ({
      id: r.id,
      author: r.author,
      isFromUs: r.isFromUs,
      body: r.body,
      createdAt: r.createdAt,
      source: r.source,
      // `kind` here is the kind of the draft the message belongs to (when the
      // extension was able to attribute it). It drives the per-message badge:
      // `dm` vs `post_comment` vs unknown.
      kind: r.draftKind ?? null,
    })),
    parentDraft: parentDraft
      ? {
          id: parentDraft.id,
          kind: parentDraft.kind,
          body: parentDraft.body,
          state: parentDraft.state,
          sentAt: parentDraft.sentAt,
        }
      : null,
    contactHistory: {
      firstContactedAt: oldest.lastContactedAt,
      lastContactedAt: latest.lastContactedAt,
      repliedAt: latest.repliedAt,
      outcome: latest.repliedAt ? 'replied' : 'awaiting',
      platformContextUrl: latest.platformContextUrl,
      chatRoomId: latest.chatRoomId,
    },
  };
}
