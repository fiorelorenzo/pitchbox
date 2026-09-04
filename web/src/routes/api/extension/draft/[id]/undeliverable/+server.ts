import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { assertDraftInDeviceOrg, requireExtensionAuth } from '$lib/server/extension-auth.js';
import { emit } from '$lib/server/events.js';
import { updateDraftWithVersion } from '$lib/server/draft-state.js';
import { requireDraftOrgId } from '@pitchbox/shared/orgs';

type UndeliverableBody = {
  reason?: string;
  detectedAt?: string;
  version?: number;
};

// States a draft can validly transition to `undeliverable` FROM. Mirrors
// SENDABLE_STATES in the sibling `sent` route: the platform only exposes
// this fact at compose time, after a human has approved (or is reviewing)
// the draft, so anything already sent/rejected/undeliverable is locked out
// (see the idempotent-repeat handling below for the `undeliverable` case).
const UNDELIVERABLE_SOURCE_STATES = new Set(['proposed', 'pending_review', 'approved']);

export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  const auth = await requireExtensionAuth(request);
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw error(400, 'invalid id');
  const body = (await request.json().catch(() => ({}))) as UndeliverableBody;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw error(400, 'reason is required');

  const db = getDb();
  await assertDraftInDeviceOrg(db, id, auth);
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');
  if (draft.state === 'undeliverable') {
    return json({ ok: true, alreadyUndeliverable: true });
  }
  if (!UNDELIVERABLE_SOURCE_STATES.has(draft.state)) {
    throw error(409, 'state_locked');
  }

  // Optimistic-locking: same convention as the sibling `sent`/`armed` routes -
  // verify a caller-supplied version, otherwise accept the current one.
  const expectedVersion = typeof body.version === 'number' ? body.version : draft.version;
  const now = body.detectedAt ? new Date(body.detectedAt) : new Date();

  const res = await updateDraftWithVersion(id, expectedVersion, {
    state: 'undeliverable',
    reviewedAt: draft.reviewedAt ?? now,
    undeliverableReason: reason,
  });
  if (res.kind === 'conflict') {
    return json(
      { error: 'version_conflict', current_version: res.currentVersion },
      { status: 409 },
    );
  }

  await db.insert(schema.draftEvents).values({
    draftId: id,
    event: 'undeliverable',
    actor: 'extension',
    details: { reason },
  });

  // The contact carries the draft's org, same reasoning as the `sent` route:
  // contact_history.organization_id is NOT NULL and must stay matchable after
  // retention prunes the draft.
  const orgId = await requireDraftOrgId(db, id);

  // Record the target as uncontactable on this platform so a future run
  // skips it (checkUncontactable, consulted from drafts:create) - see #335.
  // No message was actually sent, so this is a new contact_history row (an
  // attempt), not an update to a prior one - matching how the `sent` route
  // always inserts rather than upserts.
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
        uncontactable: true,
        uncontactableReason: reason,
      });
    }
  }

  // Quota: nothing to release. shared/src/quota.ts computes usage live from
  // COUNT(*) WHERE drafts.sent_at >= window_start (getUsageForAccounts) -
  // there is no separate "reserved" or "consumed" counter written anywhere,
  // and an undeliverable draft never sets sent_at (Send stayed disabled, so
  // the content script's onSendCompleted never ran). So no quota was ever
  // actually consumed by this attempt; releasing anything here would be
  // decrementing a counter that was never incremented.
  emit('drafts:changed', { id, state: 'undeliverable' }, orgId);
  return json({ ok: true });
}
