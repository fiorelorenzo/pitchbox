import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { getDb, schema } from '$lib/server/db.js';

// Mirrors the key scheme in ../+server.ts (#197): the heartbeat is stored
// per organization so one org's last-sync time cannot be read by another
// org's device. A null organizationId (self-host / auth-off) reads the same
// single global key that route writes.
function dmSyncHeartbeatKey(organizationId: number | null): string {
  return organizationId != null
    ? `extension_last_dm_sync_at:org:${organizationId}`
    : 'extension_last_dm_sync_at';
}

export async function GET({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, dmSyncHeartbeatKey(auth.organizationId)));
  const lastSyncAt = typeof row?.value === 'string' ? row.value : null;
  return json({ lastSyncAt });
}
