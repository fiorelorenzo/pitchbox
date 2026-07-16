import { describe, expect, it, vi, beforeEach } from 'vitest';

// snapshotSubreddit (the subreddit_snapshot MCP tool) runs on the same
// long-lived local MCP process as reddit_scout (runScout), and both hit the
// shared browser/context singletons in shared/src/platforms/reddit/client.ts.
// A concurrent scout_run + subreddit_snapshot can only avoid racing each
// other's teardown if every entry point brackets its browser use with
// acquireBrowser()/closeBrowser() - this proves snapshotSubreddit does.

const acquireBrowser = vi.fn();
const closeBrowser = vi.fn().mockResolvedValue(undefined);
const browserBrowseSubreddit = vi.fn().mockResolvedValue([]);
const browserGetSubredditAbout = vi.fn().mockResolvedValue(null);
const browserGetSubredditRules = vi.fn().mockResolvedValue([]);
const runScout = vi.fn();
const loadEnv = vi.fn(() => ({
  minIntervalMs: 0,
  maxIntervalMs: 1,
  concurrency: 1,
  headless: true,
}));

vi.mock('@pitchbox/shared/platforms/reddit', () => ({
  acquireBrowser,
  closeBrowser,
  browserBrowseSubreddit,
  browserGetSubredditAbout,
  browserGetSubredditRules,
  runScout,
  loadEnv,
}));

beforeEach(() => {
  acquireBrowser.mockClear();
  closeBrowser.mockClear();
  browserBrowseSubreddit.mockClear();
  browserGetSubredditAbout.mockClear();
  browserGetSubredditRules.mockClear();
});

describe('snapshotSubreddit browser lifecycle', () => {
  it('acquires the shared browser before scraping and releases it once done', async () => {
    const { snapshotSubreddit } = await import('../../src/commands/reddit.js');

    const order: string[] = [];
    acquireBrowser.mockImplementation(() => order.push('acquire'));
    browserBrowseSubreddit.mockImplementation(async () => {
      order.push('browse');
      return [];
    });
    closeBrowser.mockImplementation(async () => {
      order.push('close');
    });

    await snapshotSubreddit('testsub');

    expect(acquireBrowser).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    // acquire must happen before any scraping, and close only after it settles.
    expect(order[0]).toBe('acquire');
    expect(order.at(-1)).toBe('close');
  });

  it('still releases the shared browser when the scrape throws', async () => {
    const { snapshotSubreddit } = await import('../../src/commands/reddit.js');

    browserBrowseSubreddit.mockRejectedValueOnce(new Error('boom'));

    await expect(snapshotSubreddit('testsub')).rejects.toThrow('boom');

    expect(acquireBrowser).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
});
