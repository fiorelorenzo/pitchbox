import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { notify } from '@pitchbox/shared/notifications';
import { enqueueReplyDraft } from '@pitchbox/shared/reply-drafter';
import { runReplyDrafting } from '$lib/server/runner.js';
import { getDraftOrgId } from '@pitchbox/shared/orgs';
import { matchIncomingDms, type ContactRow } from '@pitchbox/shared/dm-sync';
import {
  matchIncomingCommentReplies,
  type CommentDraftRow,
  type CommentReplyContact,
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

// Bound on how many items/comments a single sync call may carry. The
// extension polls every ~10 minutes, so a legitimate batch is at most a
// couple dozen entries; this keeps a malformed or hostile payload from
// forcing an unbounded amount of DB work per request.
const MAX_BATCH_SIZE = 500;

const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'invalid date' });

// Mirrors the fields matchIncomingDms actually reads (shared/src/dm-sync.ts):
// norm() reads fromUser/toUser, the rest feed the message row/staleness check.
const IncomingDmSchema = z.object({
  fromUser: z.string().min(1),
  toUser: z.string().min(1),
  body: z.string(),
  threadId: z.string().min(1),
  createdAt: isoDateString,
  roomId: z.string().optional(),
});

// Mirrors the fields matchIncomingCommentReplies reads (shared/src/comment-sync.ts).
const IncomingCommentReplySchema = z.object({
  parentCommentId: z.string().min(1),
  replyCommentId: z.string().min(1),
  author: z.string().min(1),
  body: z.string(),
  createdAt: isoDateString,
  contextUrl: z.string(),
});

const BodyEnvelopeSchema = z.object({
  platform: z.string().min(1),
  // Elements are validated and filtered per-item in the handler (not here), so
  // a single malformed entry cannot 400 the whole batch - see #182.
  items: z.array(z.unknown()).max(MAX_BATCH_SIZE),
  comments: z.array(z.unknown()).max(MAX_BATCH_SIZE).default([]),
  status: z.unknown().optional(),
});

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

// The extension_last_dm_sync_at heartbeat used to be a single global
// app_config row: any org's sync overwrote the value every other org read
// back, and any org's device could read another org's last-sync time (#197).
// Scope it by widening the key space to one row per organization instead of
// adding a column/table - lower risk than a schema migration, since
// app_config is already a free-form key/value store. A null organizationId
// (self-host / auth-off, where requireExtensionAuth never resolves an org)
// keeps today's single global key.
function dmSyncHeartbeatKey(organizationId: number | null): string {
  return organizationId != null
    ? `extension_last_dm_sync_at:org:${organizationId}`
    : 'extension_last_dm_sync_at';
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
  const raw = await request.json().catch(() => null);
  const parsed = BodyEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid body');
  const env = parsed.data;
  // Validate elements per-item and DROP malformed ones (bad/absent date, empty
  // required field) instead of 400ing the whole batch. The extension builds
  // items from raw Reddit data with `?? ''` fallbacks, so one degenerate entry
  // must not stall the pairing's cursor and replay forever (#182); well-formed
  // items still process, and a dropped item would never have matched a contact.
  const items = env.items
    .map((it) => IncomingDmSchema.safeParse(it))
    .flatMap((r) => (r.success ? [r.data] : []));
  const comments = env.comments
    .map((it) => IncomingCommentReplySchema.safeParse(it))
    .flatMap((r) => (r.success ? [r.data] : []));

  const db = getDb();

  // Persist liveness payload before anything else so the dashboard banner
  // reacts even when the sync had zero items. Its shape is validated
  // leniently downstream (normaliseChannel / typeof checks), so it is only
  // checked here for being present and object-shaped.
  if (env.status && typeof env.status === 'object') {
    await persistDeviceSyncStatus(db, auth.deviceId, env.status as IncomingStatus);
  }

  if (items.length === 0 && comments.length === 0) {
    return json({ ok: true, inserted: 0, replied: 0, commentsInserted: 0, commentsReplied: 0 });
  }
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, env.platform));
  if (!platform) throw error(404, 'unknown platform');

  // Push the freshness predicate into SQL (#198): this used to fetch every
  // contact_history row for the platform and filter `lastContactedAt >= since`
  // in JS, so the query scaled with total history instead of the 60-day
  // window it actually needs.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  // #170/#215: when the device is bound to an org (multi-tenant / auth-on),
  // scope every match candidate to that org so a device token can't flip or
  // attach messages to another tenant's drafts/contacts. A null org (self-host
  // / auth-off) keeps full access, mirroring requireRole's no-op and the draft
  // routes' guard.
  //
  // contact_history scopes by its own durable organization_id (#215), set from
  // the draft's project at insert time, rather than joining through the draft:
  // retention prunes the draft (draft_id -> null) but the org anchor survives,
  // so a contact stays matchable for its tenant afterwards. It is also safer
  // than scoping by (accountHandle, targetUser), which is user-entered and not
  // unique across orgs. Rows with a null organization_id (self-host rows, or
  // contacts orphaned before the #215 backfill) do not match org-scoped devices.
  const orgId = auth.organizationId;
  const freshConds = [
    eq(schema.contactHistory.platformId, platform.id),
    gte(schema.contactHistory.lastContactedAt, since),
  ];
  if (orgId != null) {
    freshConds.push(eq(schema.contactHistory.organizationId, orgId));
  }
  const fresh: ContactRow[] = await db
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
    .where(and(...freshConds));

  const { inserts, updates, roomIdsByContact } = matchIncomingDms(items, fresh);

  // Comment-reply path.
  let commentDrafts: CommentDraftRow[] = [];
  let commentExisting: CommentReplyContact[] = [];
  if (comments.length > 0) {
    // #170: same org scoping for the comment path's account + draft candidates.
    let accountQuery = db
      .select({ id: schema.accounts.id, handle: schema.accounts.handle })
      .from(schema.accounts)
      .$dynamic();
    const accountConds = [eq(schema.accounts.platformId, platform.id)];
    if (orgId != null) {
      accountQuery = accountQuery.innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.accounts.projectId),
      );
      accountConds.push(eq(schema.projects.organizationId, orgId));
    }
    const accountRows = await accountQuery.where(and(...accountConds));
    const handleByAccountId = new Map(accountRows.map((a) => [a.id, a.handle]));

    let draftQuery = db
      .select({
        draftId: schema.drafts.id,
        accountId: schema.drafts.accountId,
        platformCommentId: schema.drafts.platformCommentId,
        platformPostId: schema.drafts.platformPostId,
      })
      .from(schema.drafts)
      .$dynamic();
    const draftConds = [eq(schema.drafts.platformId, platform.id)];
    if (orgId != null) {
      draftQuery = draftQuery.innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.drafts.projectId),
      );
      draftConds.push(eq(schema.projects.organizationId, orgId));
    }
    const draftRows = await draftQuery.where(and(...draftConds));
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

  // Record this device's last successful sync (#197): the device polled Reddit
  // and reached us, so its last-sync must advance even when nothing new matched
  // - otherwise the stale-device nudge (#202) would fire on an actively-syncing
  // extension. We only advance it after a SUCCESSFUL persist, though: on the
  // no-match path there is nothing to persist so we write it here; on the match
  // path it is the final statement inside the transaction below, so a failed
  // persist (rollback -> 500) leaves last-sync untouched and the device retries.
  const nowIso = new Date().toISOString();
  const lastSyncRow = { key: dmSyncHeartbeatKey(auth.organizationId), value: nowIso };

  if (inserts.length === 0 && commentMatch.messageInserts.length === 0) {
    await db
      .insert(schema.appConfig)
      .values(lastSyncRow)
      .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: nowIso } });
    return json({ ok: true, inserted: 0, replied: 0, commentsInserted: 0, commentsReplied: 0 });
  }

  // #215: resolve the org for each contact the comment path is about to create,
  // so it carries a durable org anchor (matchable after the draft is pruned).
  // For an org-scoped device every commentDraft is already that org; a null-org
  // (self-host) device falls back to the draft's own project org.
  const createdOrgByDraft = new Map<number, number | null>();
  for (const c of commentMatch.contactsToCreate) {
    if (!createdOrgByDraft.has(c.draftId)) {
      createdOrgByDraft.set(c.draftId, orgId ?? (await getDraftOrgId(db, c.draftId)));
    }
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
          organizationId: createdOrgByDraft.get(c.draftId) ?? null,
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

    // #197: advance last-sync atomically with the replies we just persisted, so
    // a rolled-back transaction never leaves last-sync ahead of the data.
    await tx
      .insert(schema.appConfig)
      .values(lastSyncRow)
      .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: nowIso } });
  });

  // Tally replies per org as we go (a single sync batch could in principle
  // touch drafts across orgs) so the summary notification below never gets
  // written with a null/unscoped org.
  const orgReplyCounts = new Map<number, number>();
  for (const u of updates) {
    if (u.draftId != null) {
      const orgId = await getDraftOrgId(db, u.draftId);
      emit('drafts:changed', { id: u.draftId, state: 'replied' }, orgId);
      if (orgId != null) orgReplyCounts.set(orgId, (orgReplyCounts.get(orgId) ?? 0) + 1);
    }
  }
  for (const ev of commentMatch.draftRepliedEvents) {
    const orgId = await getDraftOrgId(db, ev.draftId);
    emit('drafts:changed', { id: ev.draftId, state: 'replied' }, orgId);
    if (orgId != null) orgReplyCounts.set(orgId, (orgReplyCounts.get(orgId) ?? 0) + 1);
  }

  // Reply drafting (issue #49). For each draft we just flipped to `replied`,
  // enqueue a continuation draft pointing at the newest inbound message.
  // Failures are non-fatal - the original sync result must still return.
  const insertedKeys = new Set<string>([
    ...inserts.map((i) => `${i.platformId}:${i.platformMessageId}`),
    ...commentMatch.messageInserts.map((m) => `${m.platformId}:${m.platformMessageId}`),
  ]);
  // Only the drafts touched by this sync call can end up as the "newest
  // message" pick below, so bound the lookup to their ids instead of
  // scanning the whole platform's message history on every sync tick.
  const updatedDraftIds = Array.from(
    new Set<number>([
      ...updates.flatMap((u) => (u.draftId != null ? [u.draftId] : [])),
      ...commentMatch.draftRepliedEvents.map((ev) => ev.draftId),
    ]),
  );
  if (insertedKeys.size > 0 && updatedDraftIds.length > 0) {
    const newlyInsertedRows = await db
      .select({
        id: schema.messages.id,
        draftId: schema.messages.draftId,
        platformMessageId: schema.messages.platformMessageId,
        platformId: schema.messages.platformId,
        isFromUs: schema.messages.isFromUs,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.platformId, platform.id),
          inArray(schema.messages.draftId, updatedDraftIds),
        ),
      );
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
        const enq = await enqueueReplyDraft(db, {
          parentDraftId: u.draftId,
          parentMessageId: newest.id,
          replyKind: 'reply_dm',
        });
        if (enq) {
          void runReplyDrafting(enq.draftId, enq.parentMessageId).catch(() => {});
        }
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
        const enq = await enqueueReplyDraft(db, {
          parentDraftId: ev.draftId,
          parentMessageId: newest.id,
          replyKind: 'reply_comment',
        });
        if (enq) {
          void runReplyDrafting(enq.draftId, enq.parentMessageId).catch(() => {});
        }
      } catch {
        // swallow - non-fatal
      }
    }
  }

  for (const [orgId, count] of orgReplyCounts) {
    await notify(
      db,
      {
        kind: 'reply.received',
        title: `${count} repl${count === 1 ? 'y' : 'ies'} received`,
        body: 'New incoming replies have been attached to their drafts.',
        payload: { count },
        severity: 'success',
      },
      orgId,
    );
  }

  return json({
    ok: true,
    inserted: inserts.length,
    replied: updates.length,
    commentsInserted: commentMatch.messageInserts.length,
    commentsReplied: commentMatch.draftRepliedEvents.length,
  });
}
