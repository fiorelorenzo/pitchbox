import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '../../../../../../lib/server/db.js';
import { eq } from 'drizzle-orm';
import { cancelRun } from '../../../../../../lib/server/runner.js';
import { emit } from '../../../../../../lib/server/events.js';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  const db = getDb();
  const [draft] = await db
    .select({ draftingRunId: schema.drafts.draftingRunId })
    .from(schema.drafts)
    .where(eq(schema.drafts.id, id));
  if (!draft || draft.draftingRunId == null) {
    return json({ ok: false, error: 'not_drafting' }, { status: 409 });
  }
  const cancelled = await cancelRun(draft.draftingRunId);
  if (!cancelled) {
    // The in-memory cancel handle is gone (e.g. the web process restarted
    // mid-run), so the run is orphaned in 'running'. Mark it cancelled so it
    // becomes terminal and the UI can offer Retry. Do NOT clear drafting_run_id:
    // the placeholder body must stay non-approvable until a real draft lands.
    await db
      .update(schema.runs)
      .set({ status: 'cancelled', finishedAt: new Date(), error: 'cancelled by user' })
      .where(eq(schema.runs.id, draft.draftingRunId));
    emit('drafts:changed', { id });
  }
  return json({ ok: true });
}
