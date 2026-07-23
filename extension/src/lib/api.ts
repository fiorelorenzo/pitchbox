import { getSettings, patchPairing, type Pairing } from './storage.js';

export type ApiResult<T = unknown> =
  { ok: true; data: T } | { ok: false; status: number; error: string };

type DraftSummary = {
  id: number;
  kind: string;
  state: string;
  body: string;
  targetUser: string | null;
  version?: number;
};

/**
 * Resolve which pairing a single-backend op should target. Compose-time
 * content scripts pass the explicit `backendUrl` the dashboard tags onto the
 * compose URL (`pitchbox_backend`), so armed/sent reach the backend the draft
 * belongs to when several are paired. Resolution order:
 *   1. exact match on the requested backend, when given;
 *   2. otherwise the first pairing (the documented single-backend default) -
 *      never fail a lone-pairing install just because an origin string differs
 *      (e.g. localhost vs 127.0.0.1).
 * Exported for unit testing.
 */
export async function pickPairing(backendUrl?: string): Promise<Pairing | null> {
  const { pairings } = await getSettings();
  if (pairings.length === 0) return null;
  if (backendUrl) {
    const url = backendUrl.replace(/\/$/, '');
    const match = pairings.find((p) => p.backendUrl === url);
    if (match) return match;
  }
  return pairings[0];
}

// #185: rotate a device token once it's unset (never tracked, or minted
// before this field existed) or within this many days of its known expiry.
// A generous 14-day buffer against a 90-day TTL means the opportunistic
// checks below (handshake / "Test connection") only need to fire every so
// often to keep a token from ever actually expiring under normal use.
const ROTATE_BUFFER_MS = 14 * 24 * 60 * 60 * 1000;

/** Exported for unit testing. */
export function shouldRotate(
  p: Pick<Pairing, 'tokenExpiresAt'>,
  now: number = Date.now(),
): boolean {
  if (!p.tokenExpiresAt) return true;
  const expiresAt = new Date(p.tokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - now <= ROTATE_BUFFER_MS;
}

function authHeaders(p: Pairing): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${p.token}`,
  };
}

async function postJson<T>(p: Pairing, path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${p.backendUrl}${path}`, {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

async function getJson<T>(p: Pairing, path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${p.backendUrl}${path}`, { headers: authHeaders(p) });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export type DmSyncResult = ApiResult<{
  ok: true;
  inserted: number;
  replied: number;
  commentsInserted?: number;
  commentsReplied?: number;
}>;

export type DmSyncFanout = Array<DmSyncResult & { backendUrl: string }>;

/** Turn a Promise.allSettled rejection reason into a plain error string. */
function describeRejection(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export const api = {
  /**
   * Fan-out: every paired backend gets the same Reddit traffic so each
   * Pitchbox instance sees the user's full activity.
   */
  dmSync: async (
    platform: string,
    items: unknown[],
    comments: unknown[] = [],
    status?: {
      chat: 'ok' | 'unauthorized' | 'error' | 'unknown';
      legacy: 'ok' | 'unauthorized' | 'error' | 'unknown';
      captured_at: string;
    },
  ): Promise<DmSyncFanout> => {
    const { pairings } = await getSettings();
    // Fan out every pairing's POST concurrently instead of sequentially, so
    // total latency does not scale with the pairing count - a service-worker
    // alarm handler has a limited window before MV3 teardown (#193).
    const settled = await Promise.allSettled(
      pairings.map((p) => {
        const payloadStatus =
          status ??
          (p.syncStatus
            ? {
                chat: p.syncStatus.chat,
                legacy: p.syncStatus.legacy,
                captured_at: p.syncStatus.capturedAt,
              }
            : undefined);
        // #186: do NOT send captured Reddit message bodies to a backend the
        // user hasn't consented to yet (the passive auto-pair persists a
        // pairing with consentAckAt unset). Still POST the empty status
        // heartbeat so it shows as paired-awaiting-consent; full delivery
        // resumes once they acknowledge the review banner. The confirm-before-
        // persist manual flows set consentAckAt immediately.
        const consented = !!p.consentAckAt;
        return postJson<{
          ok: true;
          inserted: number;
          replied: number;
          commentsInserted?: number;
          commentsReplied?: number;
        }>(p, '/api/extension/dm-sync', {
          platform,
          items: consented ? items : [],
          comments: consented ? comments : [],
          status: payloadStatus,
        });
      }),
    );
    // Fold the settled results back in pairing order. patchPairing is
    // awaited sequentially (not fanned out) since it does a read-modify-write
    // over the whole pairings array in chrome.storage.local.
    const out: DmSyncFanout = [];
    for (let i = 0; i < pairings.length; i++) {
      const p = pairings[i];
      const settledResult = settled[i];
      const r: DmSyncResult =
        settledResult.status === 'fulfilled'
          ? settledResult.value
          : { ok: false, status: 0, error: describeRejection(settledResult.reason) };
      out.push({ ...r, backendUrl: p.backendUrl });
      // Only a real delivery (items/comments present) advances the pairing's
      // sync watermark. The empty status heartbeat (background.ts runAllSyncs)
      // must NOT bump lastDmSyncAt: doing so would move the inbox cursor
      // forward even on a tick where the inbox/chat poll actually failed,
      // silently skipping messages that arrived during the outage (#180/#188
      // rely on the watermark staying put on a failed poll).
      if (r.ok && p.consentAckAt && (items.length > 0 || comments.length > 0)) {
        await patchPairing(p.backendUrl, { lastDmSyncAt: new Date().toISOString() });
      }
    }
    return out;
  },

  // Single-backend ops below. Compose-time content scripts pass the
  // backendUrl from the URL query param; everything else uses the first
  // pairing.
  handshake: async (backendUrl?: string): Promise<ApiResult<{ ok: true; version: string }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    const res = await postJson<{ ok: true; version: string }>(p, '/api/extension/handshake', {});
    // #185: opportunistic token rotation. Handshake ("Test connection") is
    // the one place the extension makes an on-demand authenticated call, so
    // piggyback the near-expiry check here instead of adding a separate
    // poller. A pairing that has never been rotated yet (tokenExpiresAt
    // unset) rotates on the very next handshake, which starts tracking its
    // expiry going forward.
    if (res.ok && shouldRotate(p)) {
      await api.rotate(p.backendUrl);
    }
    return res;
  },

  /**
   * Mint a fresh token for the current pairing's device row and persist it in
   * place of the old one (see POST /api/extension/rotate). Safe to call
   * anytime the pairing is still valid - the server invalidates the old hash
   * immediately, so the next call must use the token this returns.
   */
  rotate: async (backendUrl?: string): Promise<ApiResult<{ token: string; expiresAt: string }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    const res = await postJson<{ token: string; expiresAt: string }>(
      p,
      '/api/extension/rotate',
      {},
    );
    if (res.ok) {
      await patchPairing(p.backendUrl, {
        token: res.data.token,
        tokenExpiresAt: res.data.expiresAt,
      });
    }
    return res;
  },

  getDraft: async (draftId: number, backendUrl?: string): Promise<ApiResult<DraftSummary>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    return getJson(p, `/api/extension/draft/${draftId}`);
  },

  armed: async (draftId: number, backendUrl?: string): Promise<ApiResult<{ ok: true }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    return postJson(p, `/api/extension/draft/${draftId}/armed`, {
      composedAt: new Date().toISOString(),
    });
  },

  sent: async (
    draftId: number,
    sentContent?: string,
    commentLookup?: { postId: string; accountHandle: string; postedAt: string },
    platformPostId?: string,
    version?: number,
    backendUrl?: string,
  ): Promise<ApiResult<{ ok: true }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    const payload = {
      sentContent,
      sentAt: new Date().toISOString(),
      commentLookup,
      platformPostId,
      version,
    };
    const first = await postJson<{ ok: true }>(p, `/api/extension/draft/${draftId}/sent`, payload);
    if (first.ok || first.status !== 409) return first;
    let parsed: { error?: string; current_version?: number } | null = null;
    try {
      parsed = JSON.parse(first.error) as { error?: string; current_version?: number };
    } catch {
      // body wasn't JSON - bail out
    }
    if (!parsed || parsed.error !== 'version_conflict') return first;
    const fresh = await getJson<DraftSummary>(p, `/api/extension/draft/${draftId}`);
    if (!fresh.ok) return first;
    return postJson<{ ok: true }>(p, `/api/extension/draft/${draftId}/sent`, {
      ...payload,
      version: fresh.data.version ?? parsed.current_version,
    });
  },

  dmSyncStatus: async (backendUrl?: string): Promise<ApiResult<{ lastSyncAt: string | null }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    return getJson(p, '/api/extension/dm-sync/status');
  },

  /**
   * Redeem a short-lived pairing code against a backend to mint a device
   * token. Unlike every other call this needs no existing pairing and no
   * session cookie: the code itself is the one-time secret (see the public
   * POST /api/extension/pair endpoint), so it works for a self-hosted or
   * teammate install that never has the dashboard open in a tab. The caller
   * must already hold host permission for `backendUrl`.
   */
  pairWithCode: async (
    backendUrl: string,
    code: string,
  ): Promise<ApiResult<{ token: string; orgName?: string | null; deviceLabel?: string }>> => {
    const base = backendUrl.replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/api/extension/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
      return {
        ok: true,
        data: (await res.json()) as {
          token: string;
          orgName?: string | null;
          deviceLabel?: string;
        },
      };
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
    }
  },
};
