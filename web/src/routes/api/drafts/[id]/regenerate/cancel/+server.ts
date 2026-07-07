import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '../../../../../../lib/server/db.js';
import { eq } from 'drizzle-orm';
import { cancelRun } from '../../../../../../lib/server/runner.js';
import { clearDraftRegeneration } from '@pitchbox/shared/draft-regenerate';
import { emit } from '../../../../../../lib/server/events.js';

export async function POST({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const db = getDb();
  const [draft] = await db
    .select({ regeneratingRunId: schema.drafts.regeneratingRunId })
    .from(schema.drafts)
    .where(eq(schema.drafts.id, id));
  if (!draft || draft.regeneratingRunId == null) {
    return json({ ok: false, error: 'not_regenerating' }, { status: 409 });
  }
  // cancelRun marks the run cancelled; dispatchRun's finally clears the flag + emits.
  const cancelled = await cancelRun(draft.regeneratingRunId);
  if (!cancelled) {
    // The in-memory cancel handle is gone (e.g. the web process restarted) but
    // the DB flag is still set. Clear it directly so the UI does not stay stuck
    // showing the spinner forever.
    await clearDraftRegeneration(db, id);
    emit('drafts:changed', { id });
    return json({ ok: true, staleCleared: true });
  }
  return json({ ok: true });
}
