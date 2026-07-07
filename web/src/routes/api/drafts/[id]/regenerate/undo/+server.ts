import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { undoDraftRegeneration } from '@pitchbox/shared/draft-regenerate';
import { emit } from '$lib/server/events.js';

export async function POST({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  try {
    const res = await undoDraftRegeneration(getDb(), id, { actor: 'user' });
    emit('drafts:changed', { id });
    return json({ ok: true, ...res });
  } catch (e) {
    throw error(400, String((e as Error).message));
  }
}
