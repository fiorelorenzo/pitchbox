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

/** The exact shape served by GET /api/extension/linkedin-assist (LI-19, #316). */
export type LinkedInAssistState = {
  enabled: boolean;
  collectorEnabled: boolean;
  killSwitch: boolean;
  projectId: number | null;
  dailyCommentCap: number;
  dailyPostCap: number;
};

// #314's in-page assist: POST /api/extension/suggest (SSE) and its accept
// half, POST /api/extension/suggest/accept. Types mirror the server's own
// zod schemas (web/src/routes/api/extension/suggest{,/accept}/+server.ts)
// rather than importing them - the extension has no dependency on the web
// workspace, matching every other api.ts shape on this file.

export type SuggestionKind = 'post_comment' | 'post';

/** The observed post context /suggest drafts from. `urn` is absent for a
 * feed sighting - see linkedin-dom.ts's "Two frontends, one identifier".
 * `text` is optional because a `kind: 'post'` request carries nothing to
 * draft from at all - the server grounds that kind itself, in whatever the
 * observation buffer most recently saw (#315). */
export type SuggestPost = {
  urn?: string;
  authorHandle?: string;
  authorName?: string;
  text?: string;
  url?: string;
};

/** What /suggest/accept sends back: the same post context, minus `text` -
 * the accepted body travels separately, as whatever the human edited it to. */
export type SuggestPostRef = Omit<SuggestPost, 'text'>;

export type SuggestUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number | null;
};

/** Every `refused` value POST /api/extension/suggest can answer with, ahead of the stream.
 * `no_recent_activity` only ever answers a `kind: 'post'` request: the observation
 * buffer this project's account has filled has nothing recent enough to draft from. */
export type SuggestRefusalReason =
  | 'assist_disabled'
  | 'kill_switch'
  | 'project_not_bound'
  | 'quota_exhausted'
  | 'no_recent_activity';

/** Every `refused` value POST /api/extension/suggest/accept can answer with: the same
 * assist gate as /suggest, plus shared/src/assist-accept.ts's own refusals for a
 * suggestion that cannot be materialised into a draft. */
export type AcceptRefusalReason =
  SuggestRefusalReason | 'no_account' | 'blocked' | 'uncontactable' | 'recently_contacted';

/**
 * One event out of /suggest, folded to one shape regardless of whether the
 * server answered a plain `200 {refused}` ahead of the stream or an actual
 * `text/event-stream` frame - a caller switches on `kind` either way.
 */
export type SuggestEvent =
  | { kind: 'status'; phase: 'reading' | 'writing' }
  | { kind: 'chunk'; text: string }
  | { kind: 'done'; text: string; usage?: SuggestUsage; ms: number }
  | { kind: 'failed'; message: string }
  | { kind: 'refused'; reason: SuggestRefusalReason; detail: Record<string, unknown> };

export type AcceptOutcome =
  | { accepted: true; draftId: number; runId: number }
  | { accepted: false; refused: AcceptRefusalReason; detail: Record<string, unknown> };

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

/**
 * Parses one `event: <kind>\ndata: <json>` frame (the text between two
 * `\n\n`-separated chunks of /suggest's stream) into a SuggestEvent. Pure
 * and exported so the chunk-boundary logic inside `api.suggest` below is
 * testable without a real ReadableStream. Returns null for the leading
 * `: <padding>` comment line the endpoint sends first, or for a frame this
 * client does not recognise, rather than throwing - a forward-compatible
 * unknown event kind should degrade silently, not crash a stream the human
 * is watching.
 */
export function parseSuggestSseFrame(frame: string): SuggestEvent | null {
  let eventKind = '';
  let dataLine = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventKind = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
  }
  if (!eventKind || !dataLine) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (eventKind) {
    case 'status':
      return data.phase === 'reading' || data.phase === 'writing'
        ? { kind: 'status', phase: data.phase }
        : null;
    case 'chunk':
      return typeof data.text === 'string' ? { kind: 'chunk', text: data.text } : null;
    case 'done':
      return typeof data.text === 'string'
        ? {
            kind: 'done',
            text: data.text,
            usage: data.usage as SuggestUsage | undefined,
            ms: typeof data.ms === 'number' ? data.ms : 0,
          }
        : null;
    case 'failed':
      return typeof data.message === 'string' ? { kind: 'failed', message: data.message } : null;
    default:
      return null;
  }
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

  undeliverable: async (
    draftId: number,
    /** Kept verbatim - the platform's own reason string, read from the page. */
    reason: string,
    backendUrl?: string,
  ): Promise<ApiResult<{ ok: true }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    return postJson(p, `/api/extension/draft/${draftId}/undeliverable`, {
      reason,
      detectedAt: new Date().toISOString(),
    });
  },

  sent: async (
    draftId: number,
    sentContent?: string,
    /** `t1_...` id of the comment this send produced, read from the page. */
    platformCommentId?: string,
    platformPostId?: string,
    version?: number,
    backendUrl?: string,
  ): Promise<ApiResult<{ ok: true }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    const payload = {
      sentContent,
      sentAt: new Date().toISOString(),
      platformCommentId,
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

  /**
   * GET /api/extension/linkedin-assist (#316): whether the org has turned
   * on the assistant/collector and which project a suggestion or an
   * observation writes as. #302's passive collector polls this - see
   * content/linkedin-observe.ts's own doc comment for the poll cadence it
   * defends. No backendUrl-targeted variant beyond the single-pairing
   * default: unlike armed/sent, this call never carries a compose-time
   * draft URL to resolve a specific backend from.
   */
  linkedinAssist: async (
    backendUrl?: string,
  ): Promise<ApiResult<{ assist: LinkedInAssistState }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    return getJson(p, '/api/extension/linkedin-assist');
  },

  /**
   * POST /api/extension/observations (#301): a debounced batch of posts the
   * passive collector (#302) saw actually render in the viewport on
   * linkedin.com. `platform` is a body field (matching dm-sync's own
   * shape) rather than baked into the path, in case a second observed
   * platform ever needs the same buffer.
   */
  observeLinkedIn: async (
    projectId: number,
    items: unknown[],
    backendUrl?: string,
  ): Promise<ApiResult<{ ok: true; inserted: number; duplicates: number; dropped: number }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    return postJson(p, '/api/extension/observations', { platform: 'linkedin', projectId, items });
  },

  /**
   * POST /api/extension/suggest (LI-15, #312): streams a suggested comment
   * or post for `params.post` as `onEvent` receives it, so the panel can
   * render a partial answer instead of a spinner for the five-to-ten-second
   * (measured: 10-14s, #360) wait before the first token. The server can
   * also answer a plain `200 {refused}` ahead of the stream (kill switch,
   * quota, an unbound project) - both shapes fold into the same `onEvent`
   * calls, so the caller has one place to switch on `event.kind`.
   *
   * The outer `ApiResult` reports only transport-level success: a network
   * failure or non-2xx status short-circuits before `onEvent` ever fires.
   * Every application-level outcome (a chunk, `done`, a mid-stream
   * `failed`, or a pre-stream `refused`) arrives through `onEvent` instead,
   * because the SSE contract has no single "final value" to return - by
   * the time the promise below resolves, every event has already been
   * delivered.
   */
  suggest: async (
    params: {
      projectId: number;
      kind: SuggestionKind;
      post: SuggestPost;
      hint?: string;
      platform?: string;
    },
    onEvent: (event: SuggestEvent) => void,
    backendUrl?: string,
  ): Promise<ApiResult<{ ok: true }>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    try {
      const res = await fetch(`${p.backendUrl}/api/extension/suggest`, {
        method: 'POST',
        headers: authHeaders(p),
        body: JSON.stringify({ platform: 'linkedin', ...params }),
      });
      if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // A pre-stream refusal: killSwitch/disabled/unbound/quota all answer
        // a renderable 200 rather than an error status (see the route's own
        // doc comment on why - a refusal is the system working, not a defect).
        const data = (await res.json()) as { refused?: SuggestRefusalReason } & Record<
          string,
          unknown
        >;
        if (data.refused) {
          const { refused, ...detail } = data;
          onEvent({ kind: 'refused', reason: refused, detail });
        } else {
          onEvent({ kind: 'failed', message: 'unexpected response from the suggestion endpoint' });
        }
        return { ok: true, data: { ok: true } };
      }
      const reader = res.body?.getReader();
      if (!reader) {
        onEvent({ kind: 'failed', message: 'the suggestion endpoint returned no body' });
        return { ok: true, data: { ok: true } };
      }
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const event = parseSuggestSseFrame(buffer.slice(0, sep));
          if (event) onEvent(event);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');
        }
      }
      return { ok: true, data: { ok: true } };
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
    }
  },

  /**
   * POST /api/extension/suggest/accept (LI-16, #313): materialises the
   * human's edited suggestion into a real draft. Unlike `suggest` above,
   * this is a plain request/response - there is one outcome to report, so it
   * comes back as the resolved value rather than through a callback. The
   * inner `AcceptOutcome.accepted` distinguishes a real refusal (quota, no
   * bound account, blocklisted, ...) from the outer `ApiResult.ok`, which
   * only reports whether the HTTP round trip itself succeeded.
   */
  acceptSuggestion: async (
    params: {
      projectId: number;
      kind: SuggestionKind;
      post: SuggestPostRef;
      body: string;
      usage?: SuggestUsage;
      ms?: number;
      platform?: string;
    },
    backendUrl?: string,
  ): Promise<ApiResult<AcceptOutcome>> => {
    const p = await pickPairing(backendUrl);
    if (!p) return { ok: false, status: 0, error: 'not configured' };
    const res = await postJson<Record<string, unknown>>(p, '/api/extension/suggest/accept', {
      platform: 'linkedin',
      ...params,
    });
    if (!res.ok) return res;
    const data = res.data;
    if (typeof data.refused === 'string') {
      const { refused, ...detail } = data;
      return {
        ok: true,
        data: { accepted: false, refused: refused as AcceptRefusalReason, detail },
      };
    }
    return {
      ok: true,
      data: { accepted: true, draftId: data.draftId as number, runId: data.runId as number },
    };
  },
};
