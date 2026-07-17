import type {
  MastodonAccount,
  MastodonNotification,
  MastodonStatus,
  NotificationsParams,
  PostStatusParams,
} from './types.js';

/** Fallback backoff when a 429 carries no usable rate-limit headers. */
const DEFAULT_RATE_LIMIT_DELAY_MS = 1_000;

/** Read a header case-insensitively from either a `Headers` or a plain object (test fixtures). */
function readHeader(
  headers: Headers | Record<string, string | null | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (headers[key] ?? null) : null;
}

/**
 * Compute how long to wait before retrying a rate-limited request, honoring
 * Mastodon's `X-RateLimit-Reset` (ISO8601 timestamp the limit window resets
 * at) and the standard `Retry-After` (seconds) header, in that priority
 * order. Falls back to a fixed delay when neither header is present or
 * parseable.
 */
export function computeRateLimitDelayMs(
  headers: Headers | Record<string, string | null | undefined>,
  now: number = Date.now(),
): number {
  const reset = readHeader(headers, 'x-ratelimit-reset');
  if (reset) {
    const resetMs = Date.parse(reset);
    if (Number.isFinite(resetMs) && resetMs > now) return resetMs - now;
  }
  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return DEFAULT_RATE_LIMIT_DELAY_MS;
}

/**
 * Minimal, structurally-compatible stand-in for the DOM `RequestInit` type.
 * Spelled out locally (rather than referencing the ambient DOM type by name)
 * so this file lints cleanly under the shared workspace's Node-only eslint
 * globals; it still satisfies `typeof fetch`'s second parameter.
 */
interface MastodonRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface MastodonClientOptions {
  /** Base URL of the instance, e.g. "https://mastodon.social" (no trailing slash needed). */
  instanceUrl: string;
  /** Bearer access token created in the instance's developer settings. */
  accessToken: string;
  /** Injectable fetch, defaults to the global one. Tests substitute a mock. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep, defaults to a real timer. Tests substitute a no-op spy. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** How many times to retry a 429 before giving up. Default 3. */
  maxRetries?: number;
}

/**
 * Thin authenticated REST client for the Mastodon API. No Playwright, no
 * scraping: every call is a plain `fetch` with a bearer token. Retries once
 * per 429 response, backing off per `computeRateLimitDelayMs`, up to
 * `maxRetries` attempts before surfacing the error.
 */
export class MastodonClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(options: MastodonClientOptions) {
    this.baseUrl = options.instanceUrl.replace(/\/+$/, '');
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async request<T>(path: string, init: MastodonRequestInit = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });

      if (res.status === 429 && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleepImpl(computeRateLimitDelayMs(res.headers));
        continue;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Mastodon API ${res.status} on ${path}${detail ? `: ${detail}` : ''}`);
      }

      return (await res.json()) as T;
    }
  }

  /** GET /api/v1/accounts/verify_credentials - validates the token and returns the owning account. */
  async verifyCredentials(): Promise<MastodonAccount> {
    return this.request<MastodonAccount>('/api/v1/accounts/verify_credentials');
  }

  /** GET /api/v1/timelines/tag/:hashtag - statuses tagged with `tag` (leading "#" is stripped), newest first. */
  async hashtagTimeline(tag: string, sinceId?: string): Promise<MastodonStatus[]> {
    const clean = tag.replace(/^#/, '');
    const params = new URLSearchParams();
    if (sinceId) params.set('since_id', sinceId);
    const qs = params.toString();
    return this.request<MastodonStatus[]>(
      `/api/v1/timelines/tag/${encodeURIComponent(clean)}${qs ? `?${qs}` : ''}`,
    );
  }

  /** GET /api/v1/statuses/:id */
  async getStatus(id: string): Promise<MastodonStatus> {
    return this.request<MastodonStatus>(`/api/v1/statuses/${encodeURIComponent(id)}`);
  }

  /** POST /api/v1/statuses - publishes a new status (a reply when `inReplyToId` is set). */
  async postStatus(params: PostStatusParams): Promise<MastodonStatus> {
    const body: Record<string, unknown> = { status: params.status };
    if (params.inReplyToId) body.in_reply_to_id = params.inReplyToId;
    if (params.visibility) body.visibility = params.visibility;
    return this.request<MastodonStatus>('/api/v1/statuses', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** GET /api/v1/notifications - optionally filtered by type (e.g. ["mention"]) and cursored by `sinceId`. */
  async notifications(params: NotificationsParams = {}): Promise<MastodonNotification[]> {
    const qs = new URLSearchParams();
    if (params.sinceId) qs.set('since_id', params.sinceId);
    for (const type of params.types ?? []) qs.append('types[]', type);
    const query = qs.toString();
    return this.request<MastodonNotification[]>(`/api/v1/notifications${query ? `?${query}` : ''}`);
  }
}
