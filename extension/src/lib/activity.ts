import { ulid } from './ulid.js';

export type ActivityLevel = 'info' | 'warn' | 'error';
export type ActivitySource =
  'pairing' | 'dm-sync' | 'chat-sync' | 'matrix-token' | 'reddit-action' | 'settings' | 'system';

export type ActivityEvent = {
  id: string;
  ts: string;
  level: ActivityLevel;
  source: ActivitySource;
  message: string;
  messageParams?: Record<string, string | number>;
  backendUrl?: string;
  meta?: Record<string, unknown>;
};

export const ACTIVITY_LOG_CAP = 500;
const KEY = 'activityLog';
const META_KEY = 'activityLogMeta';

/** Persisted alongside the entries so a dropped count survives a service-worker restart. */
type ActivityLogMeta = {
  droppedCount: number;
};

/** Facts about the ring buffer's eviction state, derived for display and export. */
export type ActivityLogStats = {
  droppedCount: number;
  oldestRetainedTs: string | null;
  cap: number;
};

async function read(): Promise<ActivityEvent[]> {
  const out = (await chrome.storage.local.get(KEY)) as { activityLog?: ActivityEvent[] };
  return Array.isArray(out.activityLog) ? out.activityLog : [];
}

async function readMeta(): Promise<ActivityLogMeta> {
  const out = (await chrome.storage.local.get(META_KEY)) as {
    activityLogMeta?: ActivityLogMeta;
  };
  const meta = out.activityLogMeta;
  return meta && typeof meta.droppedCount === 'number' ? meta : { droppedCount: 0 };
}

export async function logEvent(input: Omit<ActivityEvent, 'id' | 'ts'>): Promise<ActivityEvent> {
  const ev: ActivityEvent = { id: ulid(), ts: new Date().toISOString(), ...input };
  const current = await read();
  // Newest first; trim from the tail (oldest) when exceeding cap.
  const combined = [ev, ...current];
  const droppedNow = Math.max(0, combined.length - ACTIVITY_LOG_CAP);
  const next = combined.slice(0, ACTIVITY_LOG_CAP);
  const patch: Record<string, unknown> = { [KEY]: next };
  if (droppedNow > 0) {
    const meta = await readMeta();
    patch[META_KEY] = { droppedCount: meta.droppedCount + droppedNow } satisfies ActivityLogMeta;
  }
  await chrome.storage.local.set(patch);
  return ev;
}

export async function getActivity(): Promise<ActivityEvent[]> {
  return await read();
}

/** Eviction accounting: how many entries have ever been dropped, and the window still retained. */
export async function getActivityStats(): Promise<ActivityLogStats> {
  const [entries, meta] = await Promise.all([read(), readMeta()]);
  return {
    droppedCount: meta.droppedCount,
    oldestRetainedTs: entries.length > 0 ? entries[entries.length - 1].ts : null,
    cap: ACTIVITY_LOG_CAP,
  };
}

export async function clearActivity(): Promise<void> {
  // A cleared log starts a fresh window; nothing has been dropped from it yet.
  await chrome.storage.local.set({ [KEY]: [], [META_KEY]: { droppedCount: 0 } });
}

export async function exportActivityJSON(): Promise<Blob> {
  const [entries, meta] = await Promise.all([read(), readMeta()]);
  const payload = {
    cap: ACTIVITY_LOG_CAP,
    droppedCount: meta.droppedCount,
    oldestRetainedTs: entries.length > 0 ? entries[entries.length - 1].ts : null,
    entries,
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}
