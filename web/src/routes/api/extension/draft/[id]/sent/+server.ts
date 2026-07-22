import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { assertDraftInDeviceOrg, requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { evaluateDraftSend } from '@pitchbox/shared/draft-send';
import { updateDraftWithVersion } from '$lib/server/draft-state.js';
import { getDraftOrgId } from '@pitchbox/shared/orgs';

type SentBody = {
  sentContent?: string;
  sentAt?: string;
  commentLookup?: { postId: string; accountHandle: string; postedAt?: string };
  platformPostId?: string;
  version?: number;
};

// States a draft can validly transition to `sent` FROM. Mirrors the dashboard's
// own allowlists (see EDITABLE_STATES / RESCHEDULABLE_STATES in
// api/drafts/[id] and api/drafts/bulk-reschedule) but scoped to what "ready to
// send" means: `proposed` and `pending_review` are pre-review, `approved` is
// post-review - all three are legitimately sendable. `rejected` (including the
// losing side of an A/B variant cascade, see cascadeRejectSiblings) and any
// other state are locked out.
const SENDABLE_STATES = new Set(['proposed', 'pending_review', 'approved']);

export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  const auth = await requireExtensionAuth(request);
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw error(400, 'invalid id');
  const body = (await request.json().catch(() => ({}))) as SentBody;

  const db = getDb();
  await assertDraftInDeviceOrg(db, id, auth);
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');
  if (draft.state === 'sent') {
    return json({ ok: true, alreadySent: true });
  }
  if (!SENDABLE_STATES.has(draft.state)) {
    throw error(409, 'state_locked');
  }

  // Optimistic-locking: when the extension supplies a version, we verify it;
  // otherwise we accept the current version (the extension auto-retries once
  // after re-fetching `GET /api/extension/draft/[id]` if 409 lands).
  const expectedVersion = typeof body.version === 'number' ? body.version : draft.version;

  const now = body.sentAt ? new Date(body.sentAt) : new Date();
  const evald = await evaluateDraftSend(db, draft, now);
  if (evald.kind === 'blocked') {
    throw error(409, `blocklisted: ${evald.reason ?? 'no reason'}`);
  }
  if (evald.kind === 'scheduled') {
    throw error(409, `scheduled_send_after:${evald.sendAfter.toISOString()}`);
  }
  if (evald.kind === 'drafting') {
    throw error(409, 'draft is still being drafted');
  }
  if (evald.kind === 'quota_exceeded') {
    throw error(
      409,
      `quota_exceeded: ${evald.quotaKind} ${evald.window} limit ${evald.limit} (would be ${evald.used})`,
    );
  }

  const edited = typeof body.sentContent === 'string' && body.sentContent.trim().length > 0;
  const sentContent = edited ? body.sentContent! : draft.body;

  const res = await updateDraftWithVersion(id, expectedVersion, {
    state: 'sent',
    reviewedAt: draft.reviewedAt ?? now,
    sentAt: now,
    sentContent,
    ...(body.platformPostId ? { platformPostId: body.platformPostId } : {}),
  });
  if (res.kind === 'conflict') {
    return json(
      { error: 'version_conflict', current_version: res.currentVersion },
      { status: 409 },
    );
  }

  const details: Record<string, unknown> = {
    ...(edited && sentContent !== draft.body ? { edited: true } : {}),
    ...(evald.quotaEventDetails ?? {}),
  };

  await db.insert(schema.draftEvents).values({
    draftId: id,
    event: 'sent',
    actor: 'extension',
    details,
  });

  if (body.commentLookup && body.commentLookup.postId && body.commentLookup.accountHandle) {
    const lookup = body.commentLookup;
    const postedAtMs = lookup.postedAt ? Date.parse(lookup.postedAt) : Date.now();
    void (async () => {
      try {
        const { findOurComment } = await import('$lib/server/comment-lookup.js');
        const commentId = await findOurComment({
          postId: lookup.postId,
          accountHandle: lookup.accountHandle,
          postedAtMs,
        });
        if (commentId) {
          // platform_comment_id is a side-channel attribute, not a state
          // transition - leave the version untouched here.
          await db
            .update(schema.drafts)
            .set({ platformCommentId: commentId })
            .where(eq(schema.drafts.id, id));
        } else {
          console.warn('[pitchbox] comment lookup miss for draft', id, lookup.postId);
        }
      } catch (e) {
        console.warn('[pitchbox] comment lookup error', e);
      }
    })();
  }

  if (draft.kind === 'dm' && draft.targetUser) {
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, draft.accountId));
    if (account) {
      await db.insert(schema.contactHistory).values({
        platformId: draft.platformId,
        accountHandle: account.handle,
        targetUser: draft.targetUser,
        lastContactedAt: now,
        draftId: id,
      });
    }
  }

  const orgId = await getDraftOrgId(db, id);
  emit('drafts:changed', { id, state: 'sent' }, orgId);
  return json({ ok: true });
}
