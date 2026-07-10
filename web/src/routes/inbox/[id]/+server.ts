import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events.js';
import { evaluateDraftSend } from '@pitchbox/shared/draft-send';
import { updateDraftWithVersion } from '$lib/server/draft-state.js';
import { cascadeRejectSiblings } from '@pitchbox/shared/draft-variants';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

const ALLOWED = ['approved', 'rejected', 'sent'] as const;
type AllowedState = (typeof ALLOWED)[number];

type PatchBody = { state?: string; sentContent?: string; version?: number };

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');

  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const body = (await request.json()) as PatchBody;
  if (!body.state || !ALLOWED.includes(body.state as AllowedState)) {
    throw error(400, 'invalid state');
  }
  const newState = body.state as AllowedState;

  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');

  if (newState === 'approved' && draft.draftingRunId != null) {
    throw error(409, 'draft is still being drafted');
  }

  // Optimistic-locking: callers MAY pass the version they observed. When the
  // client omits it we fall back to the row's current version so the dashboard
  // (which doesn't surface the field yet) keeps working - but cross-tab races
  // between two explicit versions still detect the conflict on the loser.
  const expectedVersion = typeof body.version === 'number' ? body.version : draft.version;

  const now = new Date();

  if (newState === 'sent') {
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

    const edited = typeof body.sentContent === 'string' && body.sentContent.trim().length > 0;
    const sentContent = edited ? body.sentContent! : draft.body;

    const res = await updateDraftWithVersion(id, expectedVersion, {
      state: newState,
      reviewedAt: draft.reviewedAt ?? now,
      sentAt: now,
      sentContent,
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
      actor: 'user',
      details,
    });

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, draft.accountId));
    if (account && draft.targetUser) {
      await db.insert(schema.contactHistory).values({
        platformId: draft.platformId,
        accountHandle: account.handle,
        targetUser: draft.targetUser,
        lastContactedAt: now,
        draftId: id,
      });
    }
  } else {
    const res = await updateDraftWithVersion(id, expectedVersion, {
      state: newState,
      reviewedAt: draft.reviewedAt ?? now,
    });
    if (res.kind === 'conflict') {
      return json(
        { error: 'version_conflict', current_version: res.currentVersion },
        { status: 409 },
      );
    }
    await db.insert(schema.draftEvents).values({
      draftId: id,
      event: newState,
      actor: 'user',
      details: {},
    });
  }

  // A/B variant cascade (issue #20): when the winner is approved or sent,
  // reject every still-pending sibling in the same `variant_group_id`.
  if ((newState === 'approved' || newState === 'sent') && draft.variantGroupId) {
    await cascadeRejectSiblings(db, draft.variantGroupId, id, 'user');
  }

  emit('drafts:changed', { id, state: newState });
  return json({ ok: true });
}
