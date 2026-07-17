import { describe, expect, it, vi } from 'vitest';
import { computeRateLimitDelayMs, MastodonClient } from '../../../src/platforms/mastodon/client.js';
import type {
  MastodonAccount,
  MastodonNotification,
  MastodonStatus,
} from '../../../src/platforms/mastodon/types.js';

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function fakeAccount(overrides: Partial<MastodonAccount> = {}): MastodonAccount {
  return {
    id: '1',
    username: 'alice',
    acct: 'alice',
    display_name: 'Alice',
    url: 'https://mastodon.example/@alice',
    note: '',
    bot: false,
    locked: false,
    fields: [],
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<MastodonStatus> = {}): MastodonStatus {
  return {
    id: '100',
    uri: 'https://mastodon.example/users/alice/statuses/100',
    url: 'https://mastodon.example/@alice/100',
    created_at: '2026-01-01T00:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    content: '<p>hello</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    account: fakeAccount(),
    mentions: [],
    tags: [],
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    reblog: null,
    ...overrides,
  };
}

describe('computeRateLimitDelayMs', () => {
  it('prefers X-RateLimit-Reset when it is in the future', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    const reset = '2026-07-17T12:00:30.000Z';
    expect(computeRateLimitDelayMs({ 'x-ratelimit-reset': reset }, now)).toBe(30_000);
  });

  it('falls back to Retry-After (seconds) when reset is missing', () => {
    expect(computeRateLimitDelayMs({ 'retry-after': '5' })).toBe(5_000);
  });

  it('falls back to a fixed default when no usable header is present', () => {
    expect(computeRateLimitDelayMs({})).toBe(1_000);
  });

  it('ignores a reset timestamp that is already in the past', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    expect(computeRateLimitDelayMs({ 'x-ratelimit-reset': '2026-07-17T11:59:00.000Z' }, now)).toBe(
      1_000,
    );
  });
});

describe('MastodonClient', () => {
  it('verifyCredentials sends a bearer token and returns the account', async () => {
    const account = fakeAccount({ username: 'bob', acct: 'bob' });
    const fetchImpl = vi.fn(
      async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        expect(url).toBe('https://mastodon.example/api/v1/accounts/verify_credentials');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
        return jsonResponse(account);
      },
    );
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.verifyCredentials();
    expect(result).toEqual(account);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('hashtagTimeline strips a leading # and forwards sinceId', async () => {
    const statuses = [fakeStatus({ id: '10' }), fakeStatus({ id: '11' })];
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://mastodon.example/api/v1/timelines/tag/outreach?since_id=5');
      return jsonResponse(statuses);
    });
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.hashtagTimeline('#outreach', '5');
    expect(result).toEqual(statuses);
  });

  it('hashtagTimeline omits the query string when sinceId is not given', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://mastodon.example/api/v1/timelines/tag/outreach');
      return jsonResponse([]);
    });
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.hashtagTimeline('outreach');
  });

  it('getStatus fetches a single status by id', async () => {
    const status = fakeStatus({ id: '42' });
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://mastodon.example/api/v1/statuses/42');
      return jsonResponse(status);
    });
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.getStatus('42')).toEqual(status);
  });

  it('postStatus posts the body, including inReplyToId and visibility when set', async () => {
    const status = fakeStatus({ id: '200', in_reply_to_id: '199' });
    const fetchImpl = vi.fn(
      async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        expect(url).toBe('https://mastodon.example/api/v1/statuses');
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        expect(JSON.parse(init?.body as string)).toEqual({
          status: 'hello there',
          in_reply_to_id: '199',
          visibility: 'unlisted',
        });
        return jsonResponse(status);
      },
    );
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.postStatus({
      status: 'hello there',
      inReplyToId: '199',
      visibility: 'unlisted',
    });
    expect(result).toEqual(status);
  });

  it('postStatus omits inReplyToId/visibility from the body when not given', async () => {
    const fetchImpl = vi.fn(
      async (
        _url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        expect(JSON.parse(init?.body as string)).toEqual({ status: 'just a toot' });
        return jsonResponse(fakeStatus());
      },
    );
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.postStatus({ status: 'just a toot' });
  });

  it('notifications filters by sinceId and repeats types[] for each type', async () => {
    const notifications: MastodonNotification[] = [
      {
        id: '9',
        type: 'mention',
        created_at: '2026-07-17T00:00:00.000Z',
        account: fakeAccount(),
        status: fakeStatus(),
      },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://mastodon.example/api/v1/notifications?since_id=3&types%5B%5D=mention&types%5B%5D=favourite',
      );
      return jsonResponse(notifications);
    });
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.notifications({ sinceId: '3', types: ['mention', 'favourite'] });
    expect(result).toEqual(notifications);
  });

  it('throws a descriptive error on a non-429 failure response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getStatus('missing')).rejects.toThrow(/Mastodon API 404/);
  });

  it('retries a 429 after backing off per X-RateLimit-Reset, then returns the eventual success', async () => {
    const status = fakeStatus({ id: '77' });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'x-ratelimit-reset': '2026-07-17T12:00:05.000Z' },
        });
      }
      return jsonResponse(status);
    });
    const sleepImpl = vi.fn(async () => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-07-17T12:00:00.000Z'));

    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const result = await client.getStatus('77');

    expect(result).toEqual(status);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(5_000);

    vi.useRealTimers();
  });

  it('gives up after maxRetries consecutive 429s and surfaces an error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }),
    );
    const sleepImpl = vi.fn(async () => undefined);
    const client = new MastodonClient({
      instanceUrl: 'https://mastodon.example',
      accessToken: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
      maxRetries: 2,
    });

    await expect(client.getStatus('77')).rejects.toThrow(/Mastodon API 429/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });
});
