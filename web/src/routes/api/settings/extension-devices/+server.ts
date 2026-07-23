import { json, type RequestEvent } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';

export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  const db = getDb();
  // #196: this only lists devices bound to `orgId`, so a device that was
  // orphaned (organization_id null) before auto-pair/extension-pairing were
  // hardened to refuse minting one is invisible here and can't be revoked
  // from this screen. Scoping that gap fix to "when orgId is the default
  // org" would need this route to know it's looking at the default org and
  // a query change (organizationId = orgId OR organizationId IS NULL); not
  // done here to avoid widening what any org can see. Track pre-existing
  // orphans directly in the DB (`SELECT * FROM extension_devices WHERE
  // organization_id IS NULL`) if one needs revoking.
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
