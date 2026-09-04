import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { assertDraftInDeviceOrg, requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { evaluateDraftSend } from '@pitchbox/shared/draft-send';
import { updateDraftWithVersion } from '$lib/server/draft-state.js';
import { requireDraftOrgId } from '@pitchbox/shared/orgs';

type SentBody = {
  sentContent?: string;
  sentAt?: string;
  /** The `t1_...` thing id of the comment the content script just watched land. */
  platformCommentId?: string;
  platformPostId?: string;
  version?: number;
};

// A Reddit comment fullname. Narrow on purpose: this value comes from a device
// token holder and lands in the column the reply matcher joins on, so a
// free-form string would let a malformed (or hostile) id claim replies.
function isRedditCommentId(v: unknown): v is string {
  return typeof v === 'string' && /^t1_[a-z0-9]{4,16}$/i.test(v);
}

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

  // The comment's own thing id, read from the page by the content script that
  // watched the submit. It used to be resolved here instead, by fetching
  // `reddit.com/comments/<id>.json` server-side, which cannot work: measured on
  // 2026-09-04 that endpoint answers 403 to a plain fetch both from a dev box and
  // from inside the deployed web container, with and without a browser
  // user-agent. So the lookup returned null on every send and
  // `platform_comment_id` was never written, which silently cost reply
  // attribution (#337) - `shared/src/comment-sync.ts` matches an incoming `t1`
  // reply on exactly this column. The browser already has the id and the
  // session; the server has neither.
  //
  // Not a state transition, so it deliberately leaves `version` alone: the
  // extension may still be holding the version it sent with.
  if (isRedditCommentId(body.platformCommentId)) {
    await db
      .update(schema.drafts)
      .set({ platformCommentId: body.platformCommentId })
      .where(eq(schema.drafts.id, id));
  } else if (body.platformCommentId != null) {
    console.warn('[pitchbox] ignoring malformed platformCommentId for draft', id);
  }

  // The contact carries the draft's org (not the device's, which may be null on
  // a self-host / auto-paired install) so it stays matchable after retention
  // prunes the draft. Required, not optional: contact_history.organization_id is
  // NOT NULL since #263, and the draft was already loaded above, so an
  // unresolvable org here is a bug worth naming rather than a DB error.
  const orgId = await requireDraftOrgId(db, id);

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
        organizationId: orgId,
      });
    }
  }

  emit('drafts:changed', { id, state: 'sent' }, orgId);
  return json({ ok: true });
}
