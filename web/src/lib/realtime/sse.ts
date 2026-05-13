/**
 * Singleton SSE manager for /api/stream.
 *
 * Wraps EventSource with: shared connection across consumers, last-event-time
 * tracking, automatic reconnect on silence (no event for > STALE_MS), and a
 * reactive `status` consumers can render.
 *
 * Server emits `:ping` SSE comments every 15 s — see
 * web/src/routes/api/stream/+server.ts. Browsers' EventSource does not surface
 * comments as events, so we rely on named events to land regularly; if none
 * arrives in STALE_MS we drop and reconnect.
 */

export type SseStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

type Handler = (event: MessageEvent) => void;

export interface SseManager {
  on(kind: string, handler: Handler): () => void;
  close(): void;
  getStatus(): SseStatus;
  subscribeStatus(handler: (s: SseStatus) => void): () => void;
  lastEventAt(): number;
}

export const STALE_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

interface Deps {
  url?: string;
  EventSourceCtor?: typeof EventSource;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createSseManager(deps: Deps = {}): SseManager {
  const url = deps.url ?? '/api/stream';
  const ES = deps.EventSourceCtor ?? (typeof EventSource !== 'undefined' ? EventSource : null);
  const now = deps.now ?? (() => Date.now());
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;

  let es: EventSource | null = null;
  let status: SseStatus = 'connecting';
  let lastEvent = 0;
  let attempt = 0;
  let stalenessTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const statusSubs = new Set<(s: SseStatus) => void>();
  const handlers = new Map<string, Set<Handler>>();
  // One dispatcher per kind, attached to the live EventSource.
  const dispatchers = new Map<string, (e: Event) => void>();

  function setStatus(s: SseStatus) {
    if (status === s) return;
    status = s;
    for (const fn of statusSubs) fn(s);
  }

  function bumpActivity() {
    lastEvent = now();
    attempt = 0;
    setStatus('live');
    armStaleness();
  }

  function armStaleness() {
    if (stalenessTimer) clearT(stalenessTimer);
    stalenessTimer = setT(() => reconnect(), STALE_MS) as ReturnType<typeof setTimeout>;
  }

  function reconnect() {
    if (closed) return;
    teardownSource();
    setStatus('reconnecting');
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    if (reconnectTimer) clearT(reconnectTimer);
    reconnectTimer = setT(connect, backoff) as ReturnType<typeof setTimeout>;
  }

  function teardownSource() {
    if (!es) return;
    for (const [kind, fn] of dispatchers) es.removeEventListener(kind, fn);
    es.close();
    es = null;
  }

  function attachDispatcher(kind: string) {
    if (!es) return;
    const fn = (e: Event) => {
      bumpActivity();
      const set = handlers.get(kind);
      if (!set) return;
      for (const h of set) h(e as MessageEvent);
    };
    dispatchers.set(kind, fn);
    es.addEventListener(kind, fn);
  }

  function connect() {
    if (closed || !ES) return;
    setStatus(status === 'reconnecting' ? 'reconnecting' : 'connecting');
    es = new ES(url);
    es.onopen = () => bumpActivity();
    es.onmessage = () => bumpActivity();
    es.onerror = () => reconnect();
    dispatchers.clear();
    for (const kind of handlers.keys()) attachDispatcher(kind);
    armStaleness();
  }

  function on(kind: string, h: Handler): () => void {
    let set = handlers.get(kind);
    if (!set) {
      set = new Set();
      handlers.set(kind, set);
      if (es) attachDispatcher(kind);
    }
    set.add(h);
    return () => {
      const s = handlers.get(kind);
      if (!s) return;
      s.delete(h);
      if (s.size === 0) {
        handlers.delete(kind);
        const d = dispatchers.get(kind);
        if (d && es) es.removeEventListener(kind, d);
        dispatchers.delete(kind);
      }
    };
  }

  function closeManager() {
    closed = true;
    if (stalenessTimer) clearT(stalenessTimer);
    if (reconnectTimer) clearT(reconnectTimer);
    teardownSource();
    setStatus('closed');
  }

  if (ES) connect();

  return {
    on,
    close: closeManager,
    getStatus: () => status,
    subscribeStatus(handler) {
      statusSubs.add(handler);
      handler(status);
      return () => statusSubs.delete(handler);
    },
    lastEventAt: () => lastEvent,
  };
}

let singleton: SseManager | null = null;
export function getSseManager(): SseManager {
  if (!singleton) singleton = createSseManager();
  return singleton;
}

/** Test-only reset. */
export function __resetSseManager() {
  if (singleton) singleton.close();
  singleton = null;
}
