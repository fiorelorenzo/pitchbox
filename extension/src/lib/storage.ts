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
  // #200: identity of who/what this pairing points at, returned by the
  // auto-pair/pair endpoints alongside the token.
  orgName?: string;
  deviceLabel?: string;
  lastHandshakeAt?: string;
  lastDmSyncAt?: string;
  syncStatus?: SyncStatus;
  // #186: stamped once the user has explicitly acknowledged what this
  // pairing shares (every Reddit DM/comment/chat message body). The
  // confirm-before-persist flows in ConnectionCard set this immediately;
  // pairings that arrived silently (the passive auto-pair content script, or
  // installs that predate this field) leave it unset until the user
  // dismisses the one-time review banner.
  consentAckAt?: string;
  // #185: expiry of the currently-stored token, set whenever `api.rotate`
  // mints a fresh one. Unset for a pairing that predates this field or has
  // never been rotated yet - `api.ts`'s `shouldRotate` treats that the same
  // as "near expiry" so it gets a token + expiry on the next opportunistic
  // check instead of never being tracked at all.
  tokenExpiresAt?: string;
};

export type PairingHealth = 'ok' | 'warn' | 'error';

// A syncStatus snapshot older than this is treated as unknown/stale rather
// than trusted at face value - roughly 4.5x the longest configurable poller
// interval (30 min, see lib/settings.ts) so a dead background worker cannot
// keep showing a stale "ok" green dot indefinitely.
const STALE_SYNC_STATUS_MS = 45 * 60 * 1000;

const HEALTH_RANK: Record<PairingHealth, number> = { ok: 0, warn: 1, error: 2 };

function worseHealth(a: PairingHealth, b: PairingHealth): PairingHealth {
  return HEALTH_RANK[b] > HEALTH_RANK[a] ? b : a;
}

function channelHealth(status: SyncChannelStatus): PairingHealth {
  if (status === 'ok') return 'ok';
  if (status === 'error') return 'error';
  return 'warn'; // unauthorized or unknown
}

/**
 * Worst-of chat/legacy sync health for one pairing (#178), honestly derived
 * from the syncStatus the background worker persists every cycle rather than
 * hardcoded to "connected". A missing or stale snapshot counts as warn, not
 * ok, since a dead worker must not keep showing green.
 */
export function pairingHealth(p: Pairing, now: number = Date.now()): PairingHealth {
  if (!p.syncStatus) return 'warn';
  const capturedAt = new Date(p.syncStatus.capturedAt).getTime();
  if (!Number.isFinite(capturedAt) || now - capturedAt > STALE_SYNC_STATUS_MS) return 'warn';
  return worseHealth(channelHealth(p.syncStatus.chat), channelHealth(p.syncStatus.legacy));
}

/** Worst-of health across every pairing, for the card-level badge. */
export function overallHealth(pairings: Pairing[], now: number = Date.now()): PairingHealth {
  return pairings.reduce<PairingHealth>((acc, p) => worseHealth(acc, pairingHealth(p, now)), 'ok');
}

export type Settings = {
  pairings: Pairing[];
  matrixUserId?: string;
  matrixDeviceId?: string;
  matrixToken?: string;
  matrixSince?: string;
  matrixDisplayNames?: Record<string, string>;
  matrixRoomMembers?: Record<string, string[]>;
  // #175: consecutive cycles matrixSince was held back because at least one
  // paired backend didn't confirm delivery. Reset to 0 whenever the cursor
  // advances - see chat-sync.ts for the bounded-hold logic.
  matrixCursorHoldCount?: number;
  // #188: ISO timestamp before which chat-sync should not hit the Matrix
  // /sync endpoint again, set from a 429's Retry-After header.
  matrixRateLimitedUntil?: string;
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
  'matrixCursorHoldCount',
  'matrixRateLimitedUntil',
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
    matrixCursorHoldCount: stored.matrixCursorHoldCount,
    matrixRateLimitedUntil: stored.matrixRateLimitedUntil,
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
