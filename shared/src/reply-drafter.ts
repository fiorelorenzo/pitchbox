// Reply drafting trigger (issue #49).
//
// When the extension's dm-sync flips an outbound draft to `replied`, we want
// to immediately produce a follow-up draft so the human reviewer has a
// suggested continuation waiting in the inbox. This module owns the *trigger*
// path: it creates a placeholder reply draft row (kind = 'reply_dm' or
// 'reply_comment') pointing at the parent inbound message, and emits a
// `reply_drafting_enqueued` draft_event.
//
// V1 ships the wiring without the actual LLM call. The placeholder body is a
// short "[reply pending]" string so the inbox surfaces the row immediately;
// a later iteration will spawn an AgentRunner with `playbooks/reply-drafter.md`
// and fill in the real body asynchronously, then bump the draft.
import { eq, desc, and } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { drafts, draftEvents, messages, contactHistory, runs } from './db/schema.js';

export type ReplyKind = 'reply_dm' | 'reply_comment';

export interface EnqueueReplyDraftInput {
  // Parent outbound draft (the one the human originally approved/sent).
  parentDraftId: number;
  // The inbound message that triggered drafting a reply (one of the rows
  // recently inserted by dm-sync).
  parentMessageId: number;
  // 'reply_dm' for legacy/chat DM, 'reply_comment' for t1_ comment-reply.
  replyKind: ReplyKind;
}

export interface EnqueuedReplyDraft {
  draftId: number;
  parentMessageId: number;
  kind: ReplyKind;
}

const PLACEHOLDER_BODY = '[reply pending - agent run not yet executed]';

export async function enqueueReplyDraft(
  db: Db,
  input: EnqueueReplyDraftInput,
): Promise<EnqueuedReplyDraft | null> {
  const [parent] = await db.select().from(drafts).where(eq(drafts.id, input.parentDraftId));
  if (!parent) return null;
  const [msg] = await db.select().from(messages).where(eq(messages.id, input.parentMessageId));
  if (!msg) return null;
  if (msg.isFromUs) return null; // never draft a reply to our own message

  // Don't double-enqueue: if a reply draft already exists for this exact
  // parent_message_id, skip. Inbox UI relies on uniqueness here.
  const existing = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.parentMessageId, input.parentMessageId))
    .limit(1);
  if (existing.length > 0) return null;

  const [inserted] = await db
    .insert(drafts)
    .values({
      runId: parent.runId,
      projectId: parent.projectId,
      platformId: parent.platformId,
      accountId: parent.accountId,
      kind: input.replyKind,
      state: 'pending_review',
      targetUser: parent.targetUser,
      body: PLACEHOLDER_BODY,
      reasoning: `Auto-drafted reply triggered by inbound message ${input.parentMessageId}.`,
      parentMessageId: input.parentMessageId,
      sourceRef: {
        kind: 'reply',
        parentDraftId: parent.id,
        parentMessageId: input.parentMessageId,
      },
      metadata: {},
    })
    .returning({ id: drafts.id });

  await db.insert(draftEvents).values({
    draftId: inserted.id,
    event: 'reply_drafting_enqueued',
    actor: 'system',
    details: {
      parentDraftId: parent.id,
      parentMessageId: input.parentMessageId,
      kind: input.replyKind,
    },
  });

  return { draftId: inserted.id, parentMessageId: input.parentMessageId, kind: input.replyKind };
}

// Helper used by the conversations page: load the most recent reply draft for
// a (contactHistory) thread, if any. Returns null when no auto-drafted reply
// is awaiting review.
export interface PendingReplyDraft {
  id: number;
  kind: ReplyKind;
  body: string;
  state: string;
  parentMessageId: number | null;
  draftingRunId: number | null;
  draftingRunStatus: string | null;
  // Optimistic-locking version (see GRD-3/issue #106) so callers can send it
  // back on `PATCH /inbox/[id]` and let the server detect a stale write.
  version: number;
}

export async function loadPendingReplyDraft(
  db: Db,
  contactId: number,
): Promise<PendingReplyDraft | null> {
  // Reply drafts attach to messages, which attach to contact_history. Find the
  // newest reply draft whose parent_message_id belongs to this contact.
  const msgs = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.contactId, contactId));
  if (msgs.length === 0) return null;
  const ids = msgs.map((m) => m.id);
  // Drizzle: use simple sequential select to keep this dependency-free.
  for (const id of ids) {
    const [row] = await db
      .select()
      .from(drafts)
      .where(
        and(
          eq(drafts.parentMessageId, id),
          // Only surface drafts the reviewer can still act on.
          eq(drafts.state, 'pending_review'),
        ),
      )
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    if (row) {
      let draftingRunStatus: string | null = null;
      if (row.draftingRunId != null) {
        const [runRow] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, row.draftingRunId));
        draftingRunStatus = runRow?.status ?? null;
      }
      return {
        id: row.id,
        kind: row.kind as ReplyKind,
        body: row.body,
        state: row.state,
        parentMessageId: row.parentMessageId,
        draftingRunId: row.draftingRunId,
        draftingRunStatus,
        version: row.version,
      };
    }
  }
  // contactHistory is consulted just to silence the "unused import" lint when
  // future iterations need to walk by contact row. Keeping the reference here
  // documents the relationship without affecting runtime behaviour.
  void contactHistory;
  return null;
}

export interface StartReplyDraftingResult {
  run: typeof runs.$inferSelect;
  alreadyRunning: boolean;
}

/**
 * Prepare a reply_drafting run for a placeholder reply draft: guard against a
 * concurrent drafting run, inherit the runner/campaign from the parent draft's
 * originating run, insert the run row, and flag the draft as drafting. A
 * non-running (failed/orphaned) drafting_run_id is treated as replaceable so
 * Retry works after a failure or crash.
 */
export async function startReplyDrafting(
  db: Db,
  input: { replyDraftId: number; parentMessageId: number },
): Promise<StartReplyDraftingResult> {
  const { replyDraftId, parentMessageId } = input;
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, replyDraftId));
  if (!draft) throw new Error(`reply draft ${replyDraftId} not found`);
  if (draft.kind !== 'reply_dm' && draft.kind !== 'reply_comment')
    throw new Error(`draft ${replyDraftId} is not a reply draft (kind=${draft.kind})`);

  if (draft.draftingRunId != null) {
    const [existing] = await db.select().from(runs).where(eq(runs.id, draft.draftingRunId));
    if (existing && existing.status === 'running') {
      return { run: existing, alreadyRunning: true };
    }
  }

  const [origin] = await db.select().from(runs).where(eq(runs.id, draft.runId));
  const agentRunner = origin?.agentRunner ?? 'claude-code';
  const campaignId = origin?.campaignId ?? null;

  const [run] = await db
    .insert(runs)
    .values({
      kind: 'reply_drafting',
      campaignId,
      projectId: draft.projectId,
      agentRunner,
      trigger: 'manual',
      status: 'running',
      params: { replyDraftId, parentMessageId },
    })
    .returning();

  await db.update(drafts).set({ draftingRunId: run.id }).where(eq(drafts.id, replyDraftId));

  return { run, alreadyRunning: false };
}
