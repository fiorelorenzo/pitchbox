import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events.js';
import {
  evaluateDraftSend,
  mapMastodonSendParams,
  describeBlockedSend,
  type SendEvaluation,
} from '@pitchbox/shared/draft-send';
import { clientFromMastodonAccount } from '@pitchbox/shared/platforms/mastodon';
import { updateDraftWithVersion } from '$lib/server/draft-state.js';
import { cascadeRejectSiblings } from '@pitchbox/shared/draft-variants';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

const ALLOWED = ['approved', 'rejected', 'sent'] as const;
type AllowedState = (typeof ALLOWED)[number];

type PatchBody = { state?: string; sentContent?: string; version?: number };

/** Throws the same 409 the manual `sent` branch surfaces for a blocked send. */
function throwSendError(evald: Exclude<SendEvaluation, { kind: 'ok' }>): never {
  throw error(409, describeBlockedSend(evald));
}

/**
 * Resolves the campaign + Mastodon account for a draft when it belongs to an
 * `auto_post`-enabled Mastodon campaign, or `null` when auto-post does not
 * apply (any other platform, or `auto_post` off). Used by the `approved`
 * transition to decide whether to post via the API instead of just marking
 * the draft approved (MAS-5).
 */
async function resolveMastodonAutoPost(
  db: ReturnType<typeof getDb>,
  draft: typeof schema.drafts.$inferSelect,
): Promise<{ account: typeof schema.accounts.$inferSelect } | null> {
  const [platform] = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.id, draft.platformId));
  if (platform?.slug !== 'mastodon') return null;

  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, draft.runId));
  if (!run?.campaignId) return null;
  const [campaign] = await db
    .select({ autoPost: schema.campaigns.autoPost })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, run.campaignId));
  if (!campaign?.autoPost) return null;

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, draft.accountId));
  if (!account) return null;
  return { account };
}

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

  // Optimistic-locking: callers pass the version they last observed (the
  // dashboard and the extension both do this - see GRD-3/issue #106). When a
  // caller omits it we fall back to the row's current version so older
  // clients keep working, but that means only explicit versions actually
  // detect a conflict.
  const expectedVersion = typeof body.version === 'number' ? body.version : draft.version;

  const now = new Date();
  const autoPost = newState === 'approved' ? await resolveMastodonAutoPost(db, draft) : null;

  if (newState === 'sent') {
    const evald = await evaluateDraftSend(db, draft, now);
    if (evald.kind !== 'ok') throwSendError(evald);

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
  } else if (newState === 'approved' && autoPost) {
    // Auto-post campaign (MAS-5): the approve action itself sends via the
    // Mastodon API - guarded by the same evaluateDraftSend gate as manual
    // send, blocking the approve outright (nothing posted) on failure.
    const evald = await evaluateDraftSend(db, draft, now);
    if (evald.kind !== 'ok') throwSendError(evald);

    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) throw error(500, 'encryption_key_not_configured');
    const client = clientFromMastodonAccount(autoPost.account, encryptionKey);
    const params = mapMastodonSendParams({
      kind: draft.kind,
      body: draft.body,
      targetUser: draft.targetUser,
      platformCommentId: draft.platformCommentId,
    });
    const status = await client.postStatus(params);

    const res = await updateDraftWithVersion(id, expectedVersion, {
      state: 'sent',
      reviewedAt: draft.reviewedAt ?? now,
      sentAt: now,
      sentContent: params.status,
      platformPostId: status.id,
    });
    if (res.kind === 'conflict') {
      return json(
        { error: 'version_conflict', current_version: res.currentVersion },
        { status: 409 },
      );
    }

    await db.insert(schema.draftEvents).values([
      { draftId: id, event: 'approved', actor: 'user', details: {} },
      {
        draftId: id,
        event: 'sent',
        actor: 'system',
        details: { autoPosted: true, ...(evald.quotaEventDetails ?? {}) },
      },
    ]);

    if (draft.targetUser) {
      await db.insert(schema.contactHistory).values({
        platformId: draft.platformId,
        accountHandle: autoPost.account.handle,
        targetUser: draft.targetUser,
        lastContactedAt: now,
        draftId: id,
      });
    }

    if (draft.variantGroupId) {
      await cascadeRejectSiblings(db, draft.variantGroupId, id, 'user');
    }

    emit('drafts:changed', { id, state: 'sent' }, orgId);
    return json({ ok: true });
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

  emit('drafts:changed', { id, state: newState }, orgId);
  return json({ ok: true });
}
