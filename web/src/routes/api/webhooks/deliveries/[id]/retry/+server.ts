import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

/**
 * Manual retry for a dead-letter webhook delivery. Resets attempts/last_error
 * and flips status back to 'pending' so the daemon worker picks it up on the
 * next tick. Idempotent - already-pending rows just have their counters reset.
 */
export async function POST({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid_id');

  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, id));
  if (!row) throw error(404, 'not_found');
  if (row.status === 'delivered') throw error(409, 'already_delivered');

  await db
    .update(schema.webhookDeliveries)
    .set({
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.webhookDeliveries.id, id));

  return json({ ok: true });
}
