import { json, type RequestEvent } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';

export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const db = getDb();
  const rows = await db
    .select({
      id: schema.extensionDevices.id,
      label: schema.extensionDevices.label,
      createdAt: schema.extensionDevices.createdAt,
      lastSeenAt: schema.extensionDevices.lastSeenAt,
      revokedAt: schema.extensionDevices.revokedAt,
    })
    .from(schema.extensionDevices)
    .where(eq(schema.extensionDevices.organizationId, orgId))
    .orderBy(desc(schema.extensionDevices.createdAt));
  return json({ devices: rows });
}
