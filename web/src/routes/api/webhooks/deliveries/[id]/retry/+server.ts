import { json, error, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';

/**
 * Manual retry for a dead-letter webhook delivery. Resets attempts/last_error
 * and flips status back to 'pending' so the daemon worker picks it up on the
 * next tick. Idempotent - already-pending rows just have their counters reset.
 */
export async function POST(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid_id');
  const orgId = await requireOrgId(event);

  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, id));
  if (!row || row.organizationId !== orgId) throw error(404, 'not_found');
  requireRole(event, 'admin');
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
