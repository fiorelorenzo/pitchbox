export type Settings = {
  backendUrl: string;
  token: string;
  lastHandshakeAt?: string;
  lastDmSyncAt?: string;
  matrixUserId?: string;
  matrixDeviceId?: string;
  matrixToken?: string;
  matrixSince?: string;
  matrixDisplayNames?: Record<string, string>;
  matrixRoomMembers?: Record<string, string[]>;
};

const DEFAULTS: Partial<Settings> = { backendUrl: 'http://127.0.0.1:5180' };

const KEYS = [
  'backendUrl',
  'token',
  'lastHandshakeAt',
  'lastDmSyncAt',
  'matrixUserId',
  'matrixDeviceId',
  'matrixToken',
  'matrixSince',
  'matrixDisplayNames',
  'matrixRoomMembers',
];

export async function getSettings(): Promise<Partial<Settings>> {
  const stored = await chrome.storage.local.get(KEYS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
