import { and, eq, isNull } from 'drizzle-orm';
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

export type ExtensionDeviceNudgeKind = 'no_device' | 'stale_device';

export type ExtensionDeviceNudge = { kind: ExtensionDeviceNudgeKind } | null;

// Treat an org as having gone quiet if none of its non-revoked devices have
// shown any activity (a sync report, or even just the pairing itself) for
// this long. Much wider than STALE_STATUS_MS above: that one flags a chat
// token going bad while the extension is clearly still running; this one
// flags the extension not running (or never installed) at all, so it
// tolerates a much slower cadence before nagging the org to reinstall or
// re-pair.
const STALE_DEVICE_MS = 14 * 24 * 60 * 60 * 1000;

// Nudge an org to install or re-pair the browser extension when it has no
// working device: either it never paired one at all (`no_device`, a
// discovery nudge) or every device has gone quiet for STALE_DEVICE_MS
// (`stale_device`, a re-pair nudge). Returns null when at least one
// non-revoked device shows recent activity, so the Inbox/Conversations
// banners stay quiet. Unlike `hasChatUnauthorizedDevice`, this is scoped to
// a single org: device pairing is per-org, so a workspace should only be
// nudged about its own devices, never another tenant's.
export async function getExtensionDeviceNudge(orgId: number): Promise<ExtensionDeviceNudge> {
  const db = getDb();
  const rows = await db
    .select({
      lastSeenAt: schema.extensionDevices.lastSeenAt,
      createdAt: schema.extensionDevices.createdAt,
    })
    .from(schema.extensionDevices)
    .where(
      and(
        eq(schema.extensionDevices.organizationId, orgId),
        isNull(schema.extensionDevices.revokedAt),
      ),
    );

  if (rows.length === 0) return { kind: 'no_device' };

  const newestActivity = rows.reduce((latest, row) => {
    const activity = row.lastSeenAt ?? row.createdAt;
    return activity > latest ? activity : latest;
  }, rows[0].lastSeenAt ?? rows[0].createdAt);

  const cutoff = Date.now() - STALE_DEVICE_MS;
  return newestActivity.getTime() < cutoff ? { kind: 'stale_device' } : null;
}
