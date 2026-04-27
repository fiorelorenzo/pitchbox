import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
import { getDb, schema } from '$lib/server/db.js';

export async function GET({ request }: { request: Request }) {
  await requireExtensionAuth(request);
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'extension_last_dm_sync_at'));
  const lastSyncAt = typeof row?.value === 'string' ? row.value : null;
  return json({ lastSyncAt });
}
