import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { cancelRun } from '$lib/server/runner.js';

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
  await cancelRun(draft.regeneratingRunId);
  return json({ ok: true });
}
