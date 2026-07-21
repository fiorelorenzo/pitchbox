import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { assertDraftInDeviceOrg, requireExtensionAuth } from '$lib/server/extension-auth.js';

export async function GET({ params, request }: { params: { id: string }; request: Request }) {
  const auth = await requireExtensionAuth(request);
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw error(400, 'invalid id');
  const db = getDb();
  await assertDraftInDeviceOrg(db, id, auth);
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');
  return json({
    id: draft.id,
    kind: draft.kind,
    state: draft.state,
    body: draft.body,
    targetUser: draft.targetUser,
    version: draft.version,
  });
}
