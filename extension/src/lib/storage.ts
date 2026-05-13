export type SyncChannelStatus = 'ok' | 'unauthorized' | 'error' | 'unknown';

export type SyncStatus = {
  chat: SyncChannelStatus;
  legacy: SyncChannelStatus;
  capturedAt: string;
};

/**
 * One paired backend. Users can be paired with multiple at the same time
 * (e.g. cloud + self-hosted) - every DM/comment sync fans out to all of them
 * so each Pitchbox instance sees the same Reddit traffic.
 */
export type Pairing = {
  backendUrl: string;
  token: string;
  lastHandshakeAt?: string;
  lastDmSyncAt?: string;
  syncStatus?: SyncStatus;
};

export type Settings = {
  pairings: Pairing[];
  matrixUserId?: string;
  matrixDeviceId?: string;
  matrixToken?: string;
  matrixSince?: string;
  matrixDisplayNames?: Record<string, string>;
  matrixRoomMembers?: Record<string, string[]>;
};

const KEYS = [
  'pairings',
  // Legacy single-backend keys, read once on first load to migrate forward.
  'backendUrl',
  'token',
  'lastHandshakeAt',
  'lastDmSyncAt',
  'syncStatus',
  'matrixUserId',
  'matrixDeviceId',
  'matrixToken',
  'matrixSince',
  'matrixDisplayNames',
  'matrixRoomMembers',
];

type StoredShape = Partial<Settings> & {
  // Legacy single-pairing fields.
  backendUrl?: string;
  token?: string;
  lastHandshakeAt?: string;
  lastDmSyncAt?: string;
  syncStatus?: SyncStatus;
};

export async function getSettings(): Promise<Settings> {
  // KEYS includes legacy string keys outside `keyof Settings` so we bypass
  // chrome.storage's strict typing.
  const stored = (await (chrome.storage.local.get as (k: string[]) => Promise<unknown>)(
    KEYS,
  )) as StoredShape;

  let pairings: Pairing[] = Array.isArray(stored.pairings) ? stored.pairings : [];

  // Migrate the old single-backend shape on first read; persist the migration
  // so subsequent reads are clean and the legacy keys are gone.
  if (pairings.length === 0 && stored.backendUrl && stored.token) {
    pairings = [
      {
        backendUrl: stored.backendUrl,
        token: stored.token,
        lastHandshakeAt: stored.lastHandshakeAt,
        lastDmSyncAt: stored.lastDmSyncAt,
        syncStatus: stored.syncStatus,
      },
    ];
    await chrome.storage.local.set({ pairings });
    await chrome.storage.local.remove([
      'backendUrl',
      'token',
      'lastHandshakeAt',
      'lastDmSyncAt',
      'syncStatus',
    ]);
  }

  return {
    pairings,
    matrixUserId: stored.matrixUserId,
    matrixDeviceId: stored.matrixDeviceId,
    matrixToken: stored.matrixToken,
    matrixSince: stored.matrixSince,
    matrixDisplayNames: stored.matrixDisplayNames,
    matrixRoomMembers: stored.matrixRoomMembers,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Add or update a pairing keyed by backendUrl. */
export async function upsertPairing(pairing: Pairing): Promise<Pairing[]> {
  const { pairings } = await getSettings();
  const url = pairing.backendUrl.replace(/\/$/, '');
  const next: Pairing[] = pairings.filter((p) => p.backendUrl !== url);
  next.push({ ...pairing, backendUrl: url });
  await setSettings({ pairings: next });
  return next;
}

export async function removePairing(backendUrl: string): Promise<Pairing[]> {
  const { pairings } = await getSettings();
  const url = backendUrl.replace(/\/$/, '');
  const next = pairings.filter((p) => p.backendUrl !== url);
  await setSettings({ pairings: next });
  return next;
}

export async function patchPairing(
  backendUrl: string,
  patch: Partial<Pairing>,
): Promise<Pairing[]> {
  const { pairings } = await getSettings();
  const url = backendUrl.replace(/\/$/, '');
  const next = pairings.map((p) => (p.backendUrl === url ? { ...p, ...patch } : p));
  await setSettings({ pairings: next });
  return next;
}
