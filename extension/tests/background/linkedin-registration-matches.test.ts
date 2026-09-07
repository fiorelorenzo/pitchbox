import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #379: the comment send-detection, the in-page comment assistant and the
 * reply ingestion were all registered for `/feed/update/*` only, so the
 * assistant was absent from `/posts/<slug>-<id>/` - the canonical post URL,
 * which is what LinkedIn's own "copy link" produces, what a shared link
 * resolves to, and where content search sends a reader. Measured on a real
 * signed-in page: it serves the classic frontend, carries
 * `[role="article"][data-urn]` and holds the comment composer, so there was
 * nothing to gain by excluding it and a whole surface to lose.
 *
 * These assert the registered match set, not the file's text, so a future
 * refactor of how the matches are built cannot quietly drop a page.
 */

const registered: chrome.scripting.RegisteredContentScript[] = [];

const chromeMock = {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    onChanged: { addListener: vi.fn() },
  },
  alarms: { clear: vi.fn(async () => true), create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  permissions: {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    onAdded: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  scripting: {
    getRegisteredContentScripts: vi.fn(async () => []),
    registerContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => {
      registered.push(...scripts);
    }),
    unregisterContentScripts: vi.fn(async () => undefined),
  },
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    getManifest: () => ({ version: '0.0.0' }) as chrome.runtime.Manifest,
  },
};

// The mock covers only what these registrations touch, so it cannot satisfy
// the full `typeof chrome` surface. Both casts are named rather than inline:
// the global has no `chrome` in a plain vitest environment, and the mock is
// deliberately partial.
const globalWithChrome = globalThis as unknown as { chrome: typeof chrome };
const chromeApi = chromeMock as unknown as typeof chrome;
globalWithChrome.chrome = chromeApi;

beforeEach(() => {
  registered.length = 0;
  vi.clearAllMocks();
});

const POST_DETAIL_URLS = [
  'https://www.linkedin.com/feed/update/urn:li:activity:7502751599493160960/',
  'https://www.linkedin.com/posts/aiagents-share-7502751597039562752-zgxL/',
];

// 2026-09-07: the comment assist wires a composer per card on the main feed
// too (decision 1/2 of the overlay/feed rework), so its send-detection and
// the assist script itself both need to reach a plain feed URL, not only
// the two post-detail shapes above.
const FEED_URL = 'https://www.linkedin.com/feed/';

/** True when `matches` (Chrome match patterns) covers `url`. */
function covers(matches: string[] | undefined, url: string): boolean {
  return (matches ?? []).some((pattern) => {
    const rx = new RegExp(
      '^' +
        pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    return rx.test(url);
  });
}

describe('LinkedIn content scripts reach both shapes of a post-detail URL (#379)', () => {
  it('registers the comment send-detection script for /feed/update, /posts and /feed', async () => {
    const { syncLinkedInContentScript } = await import('../../src/background.js');
    await syncLinkedInContentScript();
    const entry = registered.find((s) => s.id === 'pitchbox-linkedin-comment');
    expect(entry).toBeTruthy();
    for (const url of [...POST_DETAIL_URLS, FEED_URL])
      expect(covers(entry!.matches, url)).toBe(true);
  });

  it('registers the in-page comment assistant for /feed/update, /posts and /feed', async () => {
    const { registerLinkedInCommentAssistScript } =
      await import('../../src/background/linkedin-comment-assist-registration.js');
    await registerLinkedInCommentAssistScript();
    const entry = registered.find((s) => s.id === 'pitchbox-linkedin-comment-assist');
    expect(entry).toBeTruthy();
    for (const url of [...POST_DETAIL_URLS, FEED_URL])
      expect(covers(entry!.matches, url)).toBe(true);
  });

  it('registers reply ingestion for /feed/update, /posts, notifications and messaging', async () => {
    const { registerLinkedInReplyIngestScript } =
      await import('../../src/background/linkedin-reply-ingest-registration.js');
    await registerLinkedInReplyIngestScript();
    const entry = registered.find((s) => s.id === 'pitchbox-linkedin-reply-ingest');
    expect(entry).toBeTruthy();
    for (const url of [
      ...POST_DETAIL_URLS,
      'https://www.linkedin.com/notifications/?filter=all',
      'https://www.linkedin.com/messaging/thread/123/',
    ]) {
      expect(covers(entry!.matches, url)).toBe(true);
    }
  });

  it('keeps the observation collector on the pages it already covered', async () => {
    const { syncLinkedInObserveContentScript } = await import('../../src/background.js');
    await syncLinkedInObserveContentScript();
    const entry = registered.find((s) => s.id === 'pitchbox-linkedin-observe');
    expect(entry).toBeTruthy();
    for (const url of [
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/posts/aiagents-share-7502751597039562752-zgxL/',
      'https://www.linkedin.com/in/informatizzato/recent-activity/all/',
    ]) {
      expect(covers(entry!.matches, url)).toBe(true);
    }
  });

  it('never widens past linkedin.com, so the optional grant stays meaningful', async () => {
    const { syncLinkedInContentScript, syncLinkedInObserveContentScript } =
      await import('../../src/background.js');
    await syncLinkedInContentScript();
    await syncLinkedInObserveContentScript();
    for (const entry of registered) {
      for (const pattern of entry.matches ?? []) {
        expect(pattern.startsWith('https://www.linkedin.com/')).toBe(true);
      }
    }
  });
});
