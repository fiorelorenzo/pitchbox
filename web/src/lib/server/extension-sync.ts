import { isNull } from 'drizzle-orm';
import { getDb, schema } from './db.js';

export type ExtensionSyncChannelStatus = 'ok' | 'unauthorized' | 'error' | 'unknown';

export type ExtensionDeviceSyncStatus = {
  chat: ExtensionSyncChannelStatus;
  legacy: ExtensionSyncChannelStatus;
  captured_at: string;
  updated_at: string;
};

// True when at least one non-revoked device most recently reported that its
// Matrix (Reddit Chat) token is no longer accepted. The dashboard surfaces a
// small banner so the user knows the chat poller is paused and what to do.
export async function hasChatUnauthorizedDevice(): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ status: schema.extensionDevices.lastSyncStatus })
    .from(schema.extensionDevices)
    .where(isNull(schema.extensionDevices.revokedAt));
  for (const row of rows) {
    const s = row.status as ExtensionDeviceSyncStatus | null;
    if (s && s.chat === 'unauthorized') return true;
  }
  return false;
}
