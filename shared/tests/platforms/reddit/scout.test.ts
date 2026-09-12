import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SearchOpts } from '../../../src/platforms/reddit/client.js';
import type { RedditPost, RedditUserAbout } from '../../../src/platforms/reddit/types.js';

// LOR-322: the scout used to run every keyword as a site-wide Reddit search
// and then drop every post whose subreddit was not one of the campaign's
// targets. Measured on 2026-09-12, "food logging" and "tracking calories"
// returned 32 posts across 29 subreddits with none in r/Nutrition or
// r/EatCheapAndHealthy, so a campaign scoped to those two staged nothing and
// still reported success. What this file defends is that the search itself
// carries the subreddit, so the result set is the community the campaign
// asked for.

const searchCalls: SearchOpts[] = [];
let searchResult: (opts: SearchOpts) => RedditPost[] = () => [];
let profileFailsFor: string | null = null;
let searchFailsFor: { subreddit: string; times: number } | null = null;

vi.mock('../../../src/platforms/reddit/reddit.js', () => ({
  acquireBrowser: () => undefined,
  closeBrowser: async () => undefined,
  searchPosts: async (_env: unknown, opts: SearchOpts) => {
    searchCalls.push(opts);
    if (searchFailsFor && searchFailsFor.subreddit === opts.subreddit && searchFailsFor.times > 0) {
      searchFailsFor.times--;
      throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at /r/${opts.subreddit}/`);
    }
    return searchResult(opts);
  },
  browseSubreddit: async () => [],
  getUserAbout: async (_env: unknown, name: string): Promise<RedditUserAbout> => {
    if (profileFailsFor === name) {
      throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at /user/${name}/`);
    }
    return {
      name,
      id: `t2_${name}`,
      totalKarma: 500,
      linkKarma: 200,
      commentKarma: 300,
      createdUtc: 1_600_000_000,
      isSuspended: false,
      isEmployee: false,
      acceptsFollowers: true,
    };
  },
  profileUrl: (name: string) => `https://www.reddit.com/user/${name}/`,
}));

vi.mock('../../../src/platforms/reddit/env.js', () => ({
  loadEnv: () => ({ minIntervalMs: 0, maxIntervalMs: 1, concurrency: 1, headless: true }),
}));

const NOW = new Date('2026-09-12T12:00:00Z');

function post(subreddit: string, id: string): RedditPost {
  return {
    id,
    subreddit,
    title: `a post in r/${subreddit}`,
    selftext: 'how do you all log what you eat?',
    permalink: `/r/${subreddit}/comments/${id}/x/`,
    url: `https://www.reddit.com/r/${subreddit}/comments/${id}/x/`,
    score: 12,
    numComments: 4,
    createdUtc: NOW.getTime() / 1000 - 3600,
    author: `author_${id}`,
    authorFullname: `t2_author_${id}`,
    over18: false,
    locked: false,
    stickied: false,
  };
}

describe('runScout', () => {
  beforeEach(() => {
    searchCalls.length = 0;
    searchResult = () => [];
    profileFailsFor = null;
    searchFailsFor = null;
  });

  it('searches inside each target subreddit, so what it fetches is what it can stage', async () => {
    const { runScout } = await import('../../../src/platforms/reddit/scout.js');
    searchResult = (opts) => [post(opts.subreddit ?? 'elsewhere', `p_${opts.subreddit}`)];

    const result = await runScout({
      profile: {
        targetSubreddits: ['Nutrition', 'EatCheapAndHealthy'],
        topicKeywords: ['food logging'],
      },
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(searchCalls.map((c) => c.subreddit)).toEqual(['Nutrition', 'EatCheapAndHealthy']);
    expect(result.candidates.map((c) => c.post.subreddit)).toEqual([
      'Nutrition',
      'EatCheapAndHealthy',
    ]);
  });

  it('still drops a post from another subreddit, so a search Reddit did not honour cannot leak in', async () => {
    const { runScout } = await import('../../../src/platforms/reddit/scout.js');
    searchResult = () => [post('SomeOtherSub', 'p9')];

    const result = await runScout({
      profile: { targetSubreddits: ['Nutrition'], topicKeywords: ['food logging'] },
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(result.candidates).toEqual([]);
  });

  it('asks Reddit for the window it will actually keep, not a month it then filters down to 72 hours', async () => {
    const { runScout } = await import('../../../src/platforms/reddit/scout.js');

    const base = {
      targetSubreddits: ['Nutrition'],
      topicKeywords: ['food logging'],
    };
    const call = async (maxPostAgeHours?: number | null) => {
      searchCalls.length = 0;
      await runScout({
        profile: { ...base, maxPostAgeHours },
        contactedHandles: new Set(),
        blockedHandles: new Set(),
        now: NOW,
      });
      return searchCalls[0].timeframe;
    };

    expect(await call(undefined)).toBe('week'); // default cap is 72h
    expect(await call(12)).toBe('day');
    expect(await call(24 * 20)).toBe('month');
    expect(await call(24 * 200)).toBe('year');
  });

  it('skips a candidate whose profile Reddit refuses, instead of losing the whole run to it', async () => {
    const { runScout } = await import('../../../src/platforms/reddit/scout.js');
    searchResult = () => [post('Nutrition', 'blocked'), post('Nutrition', 'ok')];
    profileFailsFor = 'author_blocked';

    const result = await runScout({
      profile: { targetSubreddits: ['Nutrition'], topicKeywords: ['food logging'] },
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
    });

    expect(result.candidates.map((c) => c.user.name)).toEqual(['author_ok']);
    expect(result.profileErrors).toBe(1);
  });

  it('retries a refused listing once and keeps the subreddits it could read', async () => {
    const { runScout } = await import('../../../src/platforms/reddit/scout.js');
    searchResult = (opts) => [post(opts.subreddit ?? 'x', `p_${opts.subreddit}`)];
    searchFailsFor = { subreddit: 'loseit', times: 1 };

    const result = await runScout({
      profile: { targetSubreddits: ['loseit', 'CICO'], topicKeywords: ['calories'] },
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
      retryDelayMs: 0,
    });

    expect(searchCalls.map((c) => c.subreddit)).toEqual(['loseit', 'loseit', 'CICO']);
    expect(result.candidates.map((c) => c.post.subreddit)).toEqual(['loseit', 'CICO']);
    expect(result.searchErrors).toBe(0);
  });

  it('gives up on a listing refused twice without losing the rest of the run', async () => {
    const { runScout } = await import('../../../src/platforms/reddit/scout.js');
    searchResult = (opts) => [post(opts.subreddit ?? 'x', `p_${opts.subreddit}`)];
    searchFailsFor = { subreddit: 'loseit', times: 2 };

    const result = await runScout({
      profile: { targetSubreddits: ['loseit', 'CICO'], topicKeywords: ['calories'] },
      contactedHandles: new Set(),
      blockedHandles: new Set(),
      now: NOW,
      retryDelayMs: 0,
    });

    expect(result.candidates.map((c) => c.post.subreddit)).toEqual(['CICO']);
    expect(result.searchErrors).toBe(1);
  });
});
