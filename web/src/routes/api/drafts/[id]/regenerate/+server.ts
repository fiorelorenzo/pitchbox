import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../../../lib/server/db.js';
import { regenerateDraft } from '@pitchbox/shared/draft-regenerate';
import { emit } from '../../../../../lib/server/events.js';

// Trigger a regeneration with an optional reviewer hint. For now this delegates
// to the shared helper which only bumps the counter + records the hint; the
// actual runner invocation is a future iteration.
type Body = { hint?: unknown };

export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');

  const payload = (await request.json().catch(() => ({}))) as Body;
  const hint =
    typeof payload.hint === 'string' && payload.hint.trim().length > 0 ? payload.hint : null;

  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');

  const res = await regenerateDraft(db, {
    draftId: id,
    hint,
    actor: 'user',
  });

  emit('drafts:changed', { id, state: draft.state });
  return json({ ok: true, ...res });
}
