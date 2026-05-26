import { isNull } from 'drizzle-orm';
import { getDb, schema } from './db.js';

export type ExtensionSyncChannelStatus = 'ok' | 'unauthorized' | 'error' | 'unknown';

export type ExtensionDeviceSyncStatus = {
  chat: ExtensionSyncChannelStatus;
  legacy: ExtensionSyncChannelStatus;
  captured_at: string;
  updated_at: string;
};

// Treat sync statuses older than this as stale (device likely offline /
// Chrome closed / extension disabled). Default poller cadence is 10 min,
// so 30 min covers ~3 missed cycles before we stop nagging.
const STALE_STATUS_MS = 30 * 60 * 1000;

// True when at least one non-revoked device **recently** reported that its
// Matrix (Reddit Chat) token is no longer accepted. The dashboard surfaces a
// small banner so the user knows the chat poller is paused and what to do.
// Old `unauthorized` reports are ignored once a fresh report comes in (the
// extension also fires an immediate sync when it captures a new token, so
// resolved states clear quickly without waiting for the next alarm tick).
export async function hasChatUnauthorizedDevice(): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ status: schema.extensionDevices.lastSyncStatus })
    .from(schema.extensionDevices)
    .where(isNull(schema.extensionDevices.revokedAt));
  const cutoff = Date.now() - STALE_STATUS_MS;
  for (const row of rows) {
    const s = row.status as ExtensionDeviceSyncStatus | null;
    if (!s || s.chat !== 'unauthorized') continue;
    const updatedAt = Date.parse(s.updated_at ?? s.captured_at ?? '');
    if (Number.isNaN(updatedAt)) continue;
    if (updatedAt < cutoff) continue;
    return true;
  }
  return false;
}
