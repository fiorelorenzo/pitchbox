import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';

export async function DELETE({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || isNaN(id)) throw error(400, 'invalid id');
  const db = getDb();
  const deleted = await db.delete(schema.blocklist).where(eq(schema.blocklist.id, id)).returning();
  if (deleted.length === 0) throw error(404, 'not found');
  return json({ ok: true, id });
}
