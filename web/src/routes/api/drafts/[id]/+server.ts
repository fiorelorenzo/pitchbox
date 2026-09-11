import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../../lib/server/db.js';
import { updateDraftWithVersion } from '../../../../lib/server/draft-state.js';
import { emit } from '../../../../lib/server/events.js';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';
import { checkStyle } from '@pitchbox/shared/style-check';

// Inline body edit before approval. Allowed only while the draft is in
// `proposed` or `pending_review`. Bumps version + sets body_edited and emits a
// `body_edited` draft_event capturing the prior body for audit.
const EDITABLE_STATES = new Set(['proposed', 'pending_review']);

type PatchBody = { body?: string; version?: number };

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');

  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');

  const payload = (await request.json().catch(() => null)) as PatchBody | null;
  if (!payload || typeof payload.body !== 'string' || payload.body.trim().length === 0) {
    throw error(400, 'body is required');
  }
  const newBody = payload.body;

  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');

  if (!EDITABLE_STATES.has(draft.state)) {
    return json({ error: 'state_locked', current_state: draft.state }, { status: 409 });
  }

  const expectedVersion = typeof payload.version === 'number' ? payload.version : draft.version;
  const priorBody = draft.body;

  // LOR-222: an edit is not run back through `enforceHouseStyle` (no model
  // call on this path, by design - see shared/src/style-check.ts), but the
  // stale findings from the pre-edit body must not linger and point the
  // reviewer at text that no longer exists. `checkStyle` is pure and cheap,
  // so it runs unconditionally, same as `drafts:create` does at write time.
  const newFindings = checkStyle(newBody).map((f) => ({
    ruleId: f.ruleId,
    message: f.message,
    span: f.span,
  }));
  const restMetadata: Record<string, unknown> = { ...(draft.metadata as Record<string, unknown>) };
  delete restMetadata.styleFindings;
  const newMetadata =
    newFindings.length > 0 ? { ...restMetadata, styleFindings: newFindings } : restMetadata;

  const res = await updateDraftWithVersion(id, expectedVersion, {
    body: newBody,
    bodyEdited: true,
    metadata: newMetadata,
  });
  if (res.kind === 'conflict') {
    return json(
      { error: 'version_conflict', current_version: res.currentVersion },
      { status: 409 },
    );
  }

  await db.insert(schema.draftEvents).values({
    draftId: id,
    event: 'body_edited',
    actor: 'user',
    details: { priorBody },
  });

  emit('drafts:changed', { id, state: draft.state }, orgId);
  return json({ ok: true, version: res.newVersion });
}
