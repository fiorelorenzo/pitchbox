import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events.js';

const ALLOWED = ['approved', 'rejected'] as const;

export async function PATCH({ params, request }: { params: { id: string }; request: Request }) {
  const id = Number(params.id);
  const body = (await request.json()) as { state?: string };
  if (!body.state || !ALLOWED.includes(body.state as (typeof ALLOWED)[number])) {
    throw error(400, 'invalid state');
  }
  const db = getDb();
  await db
    .update(schema.drafts)
    .set({ state: body.state, reviewedAt: new Date() })
    .where(eq(schema.drafts.id, id));
  await db.insert(schema.draftEvents).values({
    draftId: id,
    event: body.state,
    actor: 'user',
    details: {},
  });
  emit('drafts:changed', {});
  return json({ ok: true });
}
