import { describe, expect, it } from 'vitest';
import {
  fetchListings,
  normalizeItem,
  type Fetcher,
  type RawHnItem,
} from '../../../src/platforms/hackernews/client.js';
import { HN_ACCOUNT_SCHEMA } from '../../../src/platforms/hackernews/account.js';

const RAW_FIXTURES: Record<number, RawHnItem> = {
  1: {
    id: 1,
    type: 'story',
    by: 'pg',
    time: 1_700_000_000,
    title: 'Ask HN: How do you handle outreach?',
    text: 'We are exploring options.',
    url: undefined,
    score: 42,
    descendants: 12,
  },
  2: {
    id: 2,
    type: 'story',
    by: 'alice',
    time: 1_700_000_100,
    title: 'Show HN: New rust web framework',
    url: 'https://example.com/rust',
    score: 200,
    descendants: 80,
  },
  3: {
    id: 3,
    type: 'comment',
    by: 'bob',
    time: 1_700_000_200,
    text: 'Not a story',
  },
  4: { id: 4, type: 'story', deleted: true },
};

function fixtureFetcher(): Fetcher {
  return async (url: string): Promise<unknown> => {
    if (url.endsWith('/topstories.json')) return [1, 2, 3, 4];
    const match = url.match(/\/item\/(\d+)\.json$/);
    if (match) return RAW_FIXTURES[Number(match[1])] ?? null;
    throw new Error(`unexpected url ${url}`);
  };
}

describe('hackernews adapter', () => {
  it('normalizeItem rejects deleted/dead/non-story items', () => {
    expect(normalizeItem({ id: 99, deleted: true })).toBeNull();
    expect(normalizeItem({ id: 99, dead: true })).toBeNull();
    expect(normalizeItem({ id: 99, type: 'comment' })).toBeNull();
    expect(normalizeItem({ id: 99, type: 'pollopt' })).toBeNull();
  });

  it('normalizeItem builds itemUrl + composeUrl pointing at HN', () => {
    const item = normalizeItem({ id: 7, type: 'story', title: 't' });
    expect(item).not.toBeNull();
    expect(item!.itemUrl).toBe('https://news.ycombinator.com/item?id=7');
    expect(item!.composeUrl).toBe('https://news.ycombinator.com/reply?id=7');
  });

  it('fetchListings hydrates each id and drops non-stories', async () => {
    const items = await fetchListings({ listing: 'top', limit: 4 }, fixtureFetcher());
    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(items[0].title).toContain('Ask HN');
    expect(items[1].url).toBe('https://example.com/rust');
  });

  it('fetchListings respects the query filter (case-insensitive substring)', async () => {
    const items = await fetchListings(
      { listing: 'top', limit: 4, query: 'RUST' },
      fixtureFetcher(),
    );
    expect(items.map((i) => i.id)).toEqual([2]);
  });

  it('account schema requires only username', () => {
    expect(HN_ACCOUNT_SCHEMA.safeParse({ username: 'pg' }).success).toBe(true);
    expect(HN_ACCOUNT_SCHEMA.safeParse({ username: '' }).success).toBe(false);
    expect(HN_ACCOUNT_SCHEMA.safeParse({}).success).toBe(false);
  });
});
