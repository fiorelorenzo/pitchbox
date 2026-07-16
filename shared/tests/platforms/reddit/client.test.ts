import { describe, expect, it, vi } from 'vitest';
import type { RedditEnv } from '../../../src/platforms/reddit/env.js';

// The client-side MCP/runner process can multiplex multiple concurrent runs
// (see AGENTS.md "Cloud runner & repo layout"). Each run shares the same
// process-wide browser/context singletons in client.ts, so one run finishing
// must not tear down the browser out from under a run that is still scraping.
// This mocks Playwright at the module boundary and drives two concurrent
// browse operations to prove the shared browser survives the faster run's
// cleanup and is only closed once the slower run also finishes.

function makeDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const gate = makeDeferred<void>();
const browserClose = vi.fn().mockResolvedValue(undefined);
const contextClose = vi.fn().mockResolvedValue(undefined);

function createMockPage() {
  return {
    goto: vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('gated-sub')) {
        await gate.promise;
      }
      return { status: () => 200 };
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn(async (_selector: string, _fn: unknown, arg?: number) =>
      arg === undefined ? 0 : [],
    ),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const mockContext = {
  newPage: vi.fn(async () => createMockPage()),
  close: contextClose,
};

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: browserClose,
};

const launch = vi.fn().mockResolvedValue(mockBrowser);

vi.mock('playwright-extra', () => ({
  chromium: {
    use: () => ({ launch }),
  },
}));

vi.mock('puppeteer-extra-plugin-stealth', () => ({
  default: () => ({}),
}));

const TEST_ENV: RedditEnv = {
  minIntervalMs: 0,
  maxIntervalMs: 1,
  concurrency: 1,
  headless: true,
};

describe('reddit client browser lifecycle under concurrent runs', () => {
  it('keeps the shared browser alive while a concurrent run is still using it, closes it once the last finishes', async () => {
    const { acquireBrowser, closeBrowser, browserBrowseSubreddit } =
      await import('../../../src/platforms/reddit/client.js');

    // Simulate two concurrent runs each bracketing their scrape with
    // acquireBrowser()/closeBrowser(), exactly as scout.ts's runScout does.
    acquireBrowser();
    acquireBrowser();

    const fastRun = browserBrowseSubreddit(TEST_ENV, {
      subreddit: 'fast-sub',
      sort: 'hot',
      timeframe: 'day',
      limit: 5,
    });
    const slowRun = browserBrowseSubreddit(TEST_ENV, {
      subreddit: 'gated-sub',
      sort: 'hot',
      timeframe: 'day',
      limit: 5,
    });

    await fastRun;
    await closeBrowser(); // fast run's cleanup fires while the slow run is still gated

    expect(browserClose).not.toHaveBeenCalled();
    expect(contextClose).not.toHaveBeenCalled();

    gate.resolve();
    await slowRun;
    await closeBrowser(); // slow run's cleanup: last one out closes the browser

    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(contextClose).toHaveBeenCalledTimes(1);
  });
});
