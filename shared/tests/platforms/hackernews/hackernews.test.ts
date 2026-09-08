import { describe, expect, it } from 'vitest';
import {
  fetchListings,
  fetchUserSubmissions,
  HN_AUTHOR_CANDIDATE_CAP,
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

describe('fetchUserSubmissions', () => {
  function fixtureFetcherWithUser(
    submitted: number[],
    extraItems: Record<number, RawHnItem> = {},
  ): Fetcher {
    const items = { ...RAW_FIXTURES, ...extraItems };
    return async (url: string): Promise<unknown> => {
      if (url.endsWith('/user/pg.json')) return { id: 'pg', submitted };
      if (url.endsWith('/user/nobody.json')) return null;
      const match = url.match(/\/item\/(\d+)\.json$/);
      if (match) return items[Number(match[1])] ?? null;
      throw new Error(`unexpected url ${url}`);
    };
  }

  it('hydrates submitted ids newest-first and drops comments, keeping only stories/jobs', async () => {
    const items = await fetchUserSubmissions('pg', {}, fixtureFetcherWithUser([1, 2, 3]));
    // id 3 is a comment (dropped); ids 2 and 1 are stories, newest (higher id) first.
    expect(items.map((i) => i.id)).toEqual([2, 1]);
  });

  it('sorts candidates newest-first (highest id) before hydrating, regardless of API order', async () => {
    const items = await fetchUserSubmissions('pg', { limit: 1 }, fixtureFetcherWithUser([1, 2]));
    // id 2 is the higher (newer) id; a limit of 1 must prefer it over id 1.
    expect(items.map((i) => i.id)).toEqual([2]);
  });

  it('clamps limit to HN_AUTHOR_MAX_ITEMS regardless of what is requested', async () => {
    const manyStoryIds = Array.from({ length: 20 }, (_, i) => 100 + i);
    const extraItems: Record<number, RawHnItem> = {};
    for (const id of manyStoryIds) {
      extraItems[id] = { id, type: 'story', by: 'pg', title: `Story ${id}`, time: id };
    }
    const items = await fetchUserSubmissions(
      'pg',
      { limit: 1000 },
      fixtureFetcherWithUser(manyStoryIds, extraItems),
    );
    expect(items.length).toBe(10);
  });

  it('never hydrates more than HN_AUTHOR_CANDIDATE_CAP ids even when submitted has more', async () => {
    const manyCommentIds = Array.from({ length: 100 }, (_, i) => 200 + i);
    let hydrateCount = 0;
    const fetcher: Fetcher = async (url: string) => {
      if (url.endsWith('/user/pg.json')) return { id: 'pg', submitted: manyCommentIds };
      const match = url.match(/\/item\/(\d+)\.json$/);
      if (match) {
        hydrateCount += 1;
        return { id: Number(match[1]), type: 'comment' } satisfies RawHnItem;
      }
      throw new Error(`unexpected url ${url}`);
    };
    const items = await fetchUserSubmissions('pg', {}, fetcher);
    expect(items).toEqual([]);
    expect(hydrateCount).toBe(HN_AUTHOR_CANDIDATE_CAP);
  });

  it('returns an empty list for an unknown username instead of throwing', async () => {
    const items = await fetchUserSubmissions('nobody', {}, fixtureFetcherWithUser([]));
    expect(items).toEqual([]);
  });
});
