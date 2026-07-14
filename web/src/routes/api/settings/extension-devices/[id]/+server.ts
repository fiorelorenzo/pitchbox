import { json, error, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid_id');
  const orgId = await requireOrgId(event);
  const db = getDb();
  const [device] = await db
    .select({
      id: schema.extensionDevices.id,
      organizationId: schema.extensionDevices.organizationId,
    })
    .from(schema.extensionDevices)
    .where(eq(schema.extensionDevices.id, id));
  if (!device || device.organizationId !== orgId) throw error(404, 'not_found');
  requireRole(event, 'admin');
  await db
    .update(schema.extensionDevices)
    .set({ revokedAt: new Date() })
    .where(eq(schema.extensionDevices.id, id));
  return json({ ok: true });
}
