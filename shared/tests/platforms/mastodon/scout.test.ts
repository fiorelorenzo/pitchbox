import { describe, expect, it, vi } from 'vitest';
import { isNobotAuthor, runScout } from '../../../src/platforms/mastodon/scout.js';
import type { MastodonClient } from '../../../src/platforms/mastodon/client.js';
import type { MastodonAccount, MastodonStatus } from '../../../src/platforms/mastodon/types.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');

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
    followers_count: 10,
    following_count: 5,
    statuses_count: 100,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<MastodonStatus> = {}): MastodonStatus {
  return {
    id: '100',
    uri: 'https://mastodon.example/users/alice/statuses/100',
    url: 'https://mastodon.example/@alice/100',
    created_at: '2026-07-17T10:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    content: '<p>looking for a good outreach tool #outreach</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    account: fakeAccount(),
    mentions: [],
    tags: [{ name: 'outreach', url: 'https://mastodon.example/tags/outreach' }],
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    reblog: null,
    ...overrides,
  };
}

/** A mock MastodonClient (per hashtag) - never touches the network. */
function mockClient(byTag: Record<string, MastodonStatus[]>): MastodonClient {
  return {
    hashtagTimeline: vi.fn(async (tag: string) => byTag[tag.replace(/^#/, '')] ?? []),
  } as unknown as MastodonClient;
}

describe('isNobotAuthor', () => {
  it('flags an author whose note contains #nobot', () => {
    expect(isNobotAuthor(fakeAccount({ note: 'I post here. #nobot please.' }))).toBe(true);
  });

  it('flags an author whose note contains nobot without the hash', () => {
    expect(isNobotAuthor(fakeAccount({ note: 'nobot, do not contact me' }))).toBe(true);
  });

  it('flags an author whose profile fields mention #nobot', () => {
    const account = fakeAccount({
      note: 'hello world',
      fields: [{ name: 'Bots', value: '#nobot', verified_at: null }],
    });
    expect(isNobotAuthor(account)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isNobotAuthor(fakeAccount({ note: '#NoBot' }))).toBe(true);
  });

  it('does not flag an ordinary author', () => {
    expect(isNobotAuthor(fakeAccount({ note: 'I love robots and automation' }))).toBe(false);
  });
});

describe('runScout', () => {
  it('returns candidates matched via the hashtag timeline', async () => {
    const status = fakeStatus();
    const client = mockClient({ outreach: [status] });

    const candidates = await runScout({
      client,
      hashtags: ['#outreach'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      author: { acct: 'alice' },
      status: { id: '100' },
      matchedHashtag: 'outreach',
      matchedKeyword: null,
    });
  });

  it('skips authors whose bio contains #nobot (hard rule)', async () => {
    const status = fakeStatus({ account: fakeAccount({ acct: 'bob', note: 'please #nobot' }) });
    const client = mockClient({ outreach: [status] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(candidates).toHaveLength(0);
  });

  it('skips a status from a blocklisted handle (case-insensitive)', async () => {
    const status = fakeStatus({ account: fakeAccount({ acct: 'Spammer' }) });
    const client = mockClient({ outreach: [status] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      contactedHandles: new Set(),
      blockedHandles: new Set(['spammer']),
      now: NOW,
    });

    expect(candidates).toHaveLength(0);
  });

  it('skips a status whose content contains a blocklisted keyword', async () => {
    const status = fakeStatus({ content: '<p>buy crypto now #outreach</p>' });
    const client = mockClient({ outreach: [status] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      blockedKeywords: new Set(['crypto']),
      now: NOW,
    });

    expect(candidates).toHaveLength(0);
  });

  it('skips a status from an already-contacted handle', async () => {
    const status = fakeStatus({ account: fakeAccount({ acct: 'alice' }) });
    const client = mockClient({ outreach: [status] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      contactedHandles: new Set(['alice']),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(candidates).toHaveLength(0);
  });

  it('skips stale statuses beyond maxAgeHours', async () => {
    const stale = fakeStatus({ id: '101', created_at: '2026-07-01T00:00:00.000Z' });
    const client = mockClient({ outreach: [stale] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      maxAgeHours: 72,
      now: NOW,
    });

    expect(candidates).toHaveLength(0);
  });

  it('keeps a status within the recency window', async () => {
    const fresh = fakeStatus({ id: '102', created_at: '2026-07-16T12:00:00.000Z' });
    const client = mockClient({ outreach: [fresh] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      maxAgeHours: 72,
      now: NOW,
    });

    expect(candidates).toHaveLength(1);
  });

  it('filters by keyword when keywords are given, recording the matched keyword', async () => {
    const matching = fakeStatus({ id: '201', content: '<p>need a good crm for outreach</p>' });
    const nonMatching = fakeStatus({
      id: '202',
      content: '<p>just posting about my day</p>',
      account: fakeAccount({ acct: 'carol' }),
    });
    const client = mockClient({ outreach: [matching, nonMatching] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      keywords: ['crm'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status.id).toBe('201');
    expect(candidates[0]?.matchedKeyword).toBe('crm');
  });

  it('dedupes a status seen across multiple hashtags', async () => {
    const status = fakeStatus({
      id: '300',
      tags: [
        { name: 'outreach', url: 'https://mastodon.example/tags/outreach' },
        { name: 'marketing', url: 'https://mastodon.example/tags/marketing' },
      ],
    });
    const client = mockClient({ outreach: [status], marketing: [status] });

    const candidates = await runScout({
      client,
      hashtags: ['outreach', 'marketing'],
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(candidates).toHaveLength(1);
  });

  it('caps how many statuses are read per hashtag with perTagLimit', async () => {
    const statuses = [
      fakeStatus({ id: '400', account: fakeAccount({ acct: 'a' }) }),
      fakeStatus({ id: '401', account: fakeAccount({ acct: 'b' }) }),
      fakeStatus({ id: '402', account: fakeAccount({ acct: 'c' }) }),
    ];
    const client = mockClient({ outreach: statuses });

    const candidates = await runScout({
      client,
      hashtags: ['outreach'],
      perTagLimit: 2,
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(candidates).toHaveLength(2);
  });

  it('forwards sinceId to the client per hashtag', async () => {
    const client = mockClient({ outreach: [] });

    await runScout({
      client,
      hashtags: ['outreach'],
      sinceId: '999',
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(client.hashtagTimeline).toHaveBeenCalledWith('outreach', '999');
  });
});
