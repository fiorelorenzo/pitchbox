import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

export async function load({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
  const db = getDb();
  const [playbook] = await db.select().from(schema.playbooks).where(eq(schema.playbooks.id, id));
  if (!playbook) throw error(404, 'not found');
  return { playbook };
}
