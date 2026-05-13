import { json } from '@sveltejs/kit';
import { desc } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

export async function GET() {
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
    .orderBy(desc(schema.extensionDevices.createdAt));
  return json({ devices: rows });
}
