import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

export async function DELETE({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid_id');
  await getDb()
    .update(schema.extensionDevices)
    .set({ revokedAt: new Date() })
    .where(eq(schema.extensionDevices.id, id));
  return json({ ok: true });
}
