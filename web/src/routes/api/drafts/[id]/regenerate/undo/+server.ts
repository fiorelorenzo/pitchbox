import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { undoDraftRegeneration } from '@pitchbox/shared/draft-regenerate';
import { emit } from '$lib/server/events.js';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  if (!(await draftBelongsToOrg(getDb(), id, orgId))) throw error(404, 'not_found');
  try {
    const res = await undoDraftRegeneration(getDb(), id, { actor: 'user' });
    emit('drafts:changed', { id });
    return json({ ok: true, ...res });
  } catch (e) {
    throw error(400, String((e as Error).message));
  }
}
