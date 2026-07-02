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

async function read(): Promise<ActivityEvent[]> {
  const out = (await chrome.storage.local.get(KEY)) as { activityLog?: ActivityEvent[] };
  return Array.isArray(out.activityLog) ? out.activityLog : [];
}

async function write(next: ActivityEvent[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: next });
}

export async function logEvent(input: Omit<ActivityEvent, 'id' | 'ts'>): Promise<ActivityEvent> {
  const ev: ActivityEvent = { id: ulid(), ts: new Date().toISOString(), ...input };
  const current = await read();
  // Newest first; trim from the tail (oldest) when exceeding cap.
  const next = [ev, ...current].slice(0, ACTIVITY_LOG_CAP);
  await write(next);
  return ev;
}

export async function getActivity(): Promise<ActivityEvent[]> {
  return await read();
}

export async function clearActivity(): Promise<void> {
  await write([]);
}

export async function exportActivityJSON(): Promise<Blob> {
  const all = await read();
  return new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
}
