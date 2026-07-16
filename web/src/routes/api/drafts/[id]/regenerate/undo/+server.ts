import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { undoDraftRegeneration } from '@pitchbox/shared/draft-regenerate';
import { emit } from '$lib/server/events.js';
import { requireOrgId } from '$lib/server/auth.js';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';

export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const orgId = await requireOrgId(event);
  const db = getDb();
  if (!(await draftBelongsToOrg(db, id, orgId))) throw error(404, 'not_found');
  const [draft] = await db
    .select({ version: schema.drafts.version })
    .from(schema.drafts)
    .where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'not_found');
  try {
    const res = await undoDraftRegeneration(db, id, draft.version, { actor: 'user' });
    if (res.kind === 'conflict') {
      return json(
        { error: 'version_conflict', current_version: res.currentVersion },
        { status: 409 },
      );
    }
    emit('drafts:changed', { id }, orgId);
    return json({ ok: true, draftId: res.draftId, version: res.version });
  } catch (e) {
    throw error(400, String((e as Error).message));
  }
}
