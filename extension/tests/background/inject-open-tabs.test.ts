import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #438: registering a content script only ever injects into documents that
 * load afterwards, so the LinkedIn tabs a human already has open - including
 * the one they came back to right after granting the permission - stay
 * scriptless until they reload. Measured in a signed-in Chrome: nothing
 * happens on the page and nothing is logged anywhere, which reads as a
 * broken feature rather than an un-injected one.
 *
 * These drive the real module against a fake `chrome`, asserting what it
 * injects where, since the whole value of the module is that it derives its
 * work from the registry instead of a second copy of every match set.
 */

type Injection = { tabId: number; files: string[] };

let granted = true;
let registered: chrome.scripting.RegisteredContentScript[] = [];
let tabs: Array<{ id?: number; url: string }> = [];
let injections: Injection[] = [];
let failingTabs = new Set<number>();
let queriedWith: unknown = null;

const chromeMock = {
  permissions: {
    contains: vi.fn(async () => granted),
  },
  scripting: {
    getRegisteredContentScripts: vi.fn(async () => registered),
    executeScript: vi.fn(
      async (injection: { target: { tabId: number }; files: string[] }): Promise<void> => {
        if (failingTabs.has(injection.target.tabId)) {
          throw new Error('cannot access a discarded tab');
        }
        injections.push({ tabId: injection.target.tabId, files: injection.files });
      },
    ),
  },
  tabs: {
    query: vi.fn(async (info: unknown) => {
      queriedWith = info;
      return tabs;
    }),
  },
};

const globalWithChrome = globalThis as unknown as { chrome: typeof chrome };
globalWithChrome.chrome = chromeMock as unknown as typeof chrome;

const { injectIntoOpenLinkedInTabs } = await import('../../src/background/inject-open-tabs.js');

beforeEach(() => {
  vi.clearAllMocks();
  granted = true;
  injections = [];
  failingTabs = new Set();
  queriedWith = null;
  registered = [
    { id: 'pitchbox-linkedin-comment-assist', js: ['assets/comment-assist.js'] },
    { id: 'pitchbox-linkedin-observe', js: ['assets/observe.js'] },
    // Not ours, and one of ours with nothing to inject: both must be skipped.
    { id: 'some-other-extension-script', js: ['assets/other.js'] },
    { id: 'pitchbox-linkedin-broken', js: [] },
  ] as chrome.scripting.RegisteredContentScript[];
  tabs = [
    { id: 11, url: 'https://www.linkedin.com/feed/' },
    { id: 12, url: 'https://www.linkedin.com/in/informatizzato/' },
  ];
});

describe('injecting into the LinkedIn tabs that were already open (#438)', () => {
  it('runs every registered pitchbox script in every open LinkedIn tab', async () => {
    const count = await injectIntoOpenLinkedInTabs();

    expect(count).toBe(4);
    expect(injections).toEqual([
      { tabId: 11, files: ['assets/comment-assist.js'] },
      { tabId: 11, files: ['assets/observe.js'] },
      { tabId: 12, files: ['assets/comment-assist.js'] },
      { tabId: 12, files: ['assets/observe.js'] },
    ]);
    expect(queriedWith).toEqual({ url: 'https://www.linkedin.com/*' });
  });

  it('injects nothing at all when the LinkedIn permission is not granted', async () => {
    granted = false;

    expect(await injectIntoOpenLinkedInTabs()).toBe(0);
    expect(injections).toEqual([]);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });

  it('keeps going when one tab refuses, rather than losing the rest', async () => {
    failingTabs.add(11);

    const count = await injectIntoOpenLinkedInTabs();

    expect(count).toBe(2);
    expect(injections.map((i) => i.tabId)).toEqual([12, 12]);
  });

  it('injects nothing when no script is registered yet', async () => {
    registered = [];

    expect(await injectIntoOpenLinkedInTabs()).toBe(0);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });

  it('skips a tab Chrome reports with no id', async () => {
    tabs = [
      { url: 'https://www.linkedin.com/feed/' },
      { id: 12, url: 'https://www.linkedin.com/' },
    ];

    expect(await injectIntoOpenLinkedInTabs()).toBe(2);
    expect(injections.every((i) => i.tabId === 12)).toBe(true);
  });
});
