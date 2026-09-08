// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { releaseDocumentClaimsForTests } from '../../src/content/shared/claim-document.js';
import linkedinSourceCaptureSource from '../../src/content/linkedin-source-capture.ts?raw';
// Real, anonymised captures - see fixtures/linkedin/README.md.
import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';
import OWN_PROFILE_HTML from './fixtures/linkedin/own-profile.html?raw';

const BACKEND = 'https://backend.example';
const PAIRING = { backendUrl: BACKEND, token: 't'.repeat(40) };
const MATCH_PATH = '/api/extension/project-source-match';

function installChromeMock() {
  (globalThis as any).chrome = {
    storage: {
      local: {
        _s: {} as Record<string, unknown>,
        async get(keys: string[] | string) {
          const k = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const x of k) if (x in (this._s as any)) out[x] = (this._s as any)[x];
          return out;
        },
        async set(patch: Record<string, unknown>) {
          Object.assign(this._s as any, patch);
        },
      },
    },
    runtime: { sendMessage: vi.fn() },
  };
}

function seedPairing() {
  ((globalThis as any).chrome.storage.local as any)._s = { pairings: [PAIRING] };
}

function loggedEvents(): Array<Record<string, any>> {
  const fn = (globalThis as any).chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
  return fn.mock.calls.map((args: any[]) => args[0]?.event);
}

// Relative pushState resolves against the current (default jsdom) origin,
// same helper linkedin-dom.test.ts and linkedin-profile-capture.test.ts use.
function setUrl(pathAndSearch: string): void {
  window.history.pushState({}, '', pathAndSearch);
}

function render(html: string): void {
  document.body.innerHTML = html;
}

async function flushMicrotasks(times = 15) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

type MatchResult = { status: number; body: unknown };
type FillResult = { status: number; body: unknown };

function installFetchMock(
  opts: {
    onMatch?: (params: URLSearchParams) => MatchResult;
    onFill?: (body: Record<string, unknown>) => FillResult;
  } = {},
) {
  const matchCalls: URLSearchParams[] = [];
  const fillCalls: Array<Record<string, unknown>> = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== MATCH_PATH) throw new Error(`unexpected fetch url: ${url}`);
    if (!init?.method || init.method === 'GET') {
      matchCalls.push(url.searchParams);
      const result = opts.onMatch?.(url.searchParams) ?? { status: 200, body: { match: null } };
      return new Response(JSON.stringify(result.body), { status: result.status });
    }
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      fillCalls.push(body);
      const result = opts.onFill?.(body) ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(result.body), { status: result.status });
    }
    throw new Error(`unexpected method: ${init.method}`);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, matchCalls, fillCalls };
}

async function importModule() {
  return await import('../../src/content/linkedin-source-capture.js');
}

beforeEach(() => {
  // #438: the claim guard outlives vi.resetModules() by design.
  releaseDocumentClaimsForTests();
  document.documentElement.innerHTML = '<head></head><body></body>';
  setUrl('/feed/');
  installChromeMock();
  seedPairing();
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('linkedin_post: a post-detail page matching a pending source', () => {
  it('asks once, then fills the row with the urn, author, text and url', async () => {
    render(POST_DETAIL_HTML);
    const { matchCalls, fillCalls } = installFetchMock({
      onMatch: () => ({ status: 200, body: { match: { sourceId: 42 } } }),
    });

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0].get('kind')).toBe('linkedin_post');
    expect(matchCalls[0].get('identifier')).toBe('urn:li:activity:7000000000000000001');

    expect(fillCalls).toHaveLength(1);
    expect(fillCalls[0]).toMatchObject({
      sourceId: 42,
      kind: 'linkedin_post',
      identifier: 'urn:li:activity:7000000000000000001',
      output: {
        urn: 'urn:li:activity:7000000000000000001',
        authorHandle: 'example-person',
        authorName: 'Giulia Bianchi',
      },
    });
    expect((fillCalls[0].output as Record<string, unknown>).text).toMatch(/ingest path/);
  });

  it('never fills again after a benign re-render (only one fill per page view)', async () => {
    render(POST_DETAIL_HTML);
    const { fillCalls } = installFetchMock({
      onMatch: () => ({ status: 200, body: { match: { sourceId: 42 } } }),
    });

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(fillCalls).toHaveLength(1);

    render(POST_DETAIL_HTML);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(fillCalls).toHaveLength(1);
  });
});

describe('no pending source: nothing is ever read from the DOM', () => {
  it('asks once and stops - no fill call, ever, even across further mutations', async () => {
    render(POST_DETAIL_HTML);
    const { matchCalls, fillCalls } = installFetchMock({
      onMatch: () => ({ status: 200, body: { match: null } }),
    });

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    render(POST_DETAIL_HTML);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(matchCalls).toHaveLength(1);
    expect(fillCalls).toHaveLength(0);
  });
});

describe('matched, but the post has not rendered yet', () => {
  it('retries the fill on the next tick without asking the server again', async () => {
    // A post-detail page with the urn already on it (so the match can
    // resolve) but its text container not rendered yet - mirrors what a
    // page mid-hydration looks like.
    render(
      '<div role="article" data-urn="urn:li:activity:7000000000000000001" data-view-name="post"></div>',
    );
    const { matchCalls, fillCalls } = installFetchMock({
      onMatch: () => ({ status: 200, body: { match: { sourceId: 9 } } }),
    });

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(matchCalls).toHaveLength(1);
    expect(fillCalls).toHaveLength(0);

    // The body renders on the next tick.
    render(POST_DETAIL_HTML);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    // Still exactly one match ask - the resolved sourceId was cached.
    expect(matchCalls).toHaveLength(1);
    expect(fillCalls).toHaveLength(1);
  });
});

describe('linkedin_profile: a third party profile page matching a pending source', () => {
  it("fills the row with the page's own subject, reusing readOwnProfile with zero changes", async () => {
    setUrl('/in/example-person/');
    render(OWN_PROFILE_HTML);
    const { matchCalls, fillCalls } = installFetchMock({
      onMatch: () => ({ status: 200, body: { match: { sourceId: 7 } } }),
    });

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0].get('kind')).toBe('linkedin_profile');
    expect(matchCalls[0].get('identifier')).toBe('example-person');

    expect(fillCalls).toHaveLength(1);
    expect(fillCalls[0]).toMatchObject({
      sourceId: 7,
      kind: 'linkedin_profile',
      identifier: 'example-person',
      output: { handle: 'example-person', displayName: 'Giulia Bianchi' },
    });
  });

  it('never asks about a profile page with no handle at all', async () => {
    setUrl('/feed/');
    render('<main><div>not a profile page</div></main>');
    const { matchCalls } = installFetchMock();

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(matchCalls).toHaveLength(0);
  });
});

describe('a failed match request is retried, not cached as a miss', () => {
  it('asks again on the next tick after a transient failure', async () => {
    render(POST_DETAIL_HTML);
    let calls = 0;
    const { matchCalls, fillCalls } = installFetchMock({
      onMatch: () => {
        calls += 1;
        return calls === 1
          ? { status: 500, body: { message: 'boom' } }
          : { status: 200, body: { match: { sourceId: 3 } } };
      },
    });

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(matchCalls).toHaveLength(1);
    expect(fillCalls).toHaveLength(0);

    render(POST_DETAIL_HTML);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(matchCalls).toHaveLength(2);
    expect(fillCalls).toHaveLength(1);
  });
});

describe('selector health: forwarded through logFromContent, not swallowed', () => {
  it('reports a selector miss on the tick after it happened (post-detail page kind, no post card)', async () => {
    // reportSelectorHealth() runs at the top of scan(), so a miss recorded
    // during tick N is only reported at the start of tick N+1 - matches
    // linkedin-profile-capture.ts's own scan() shape. selectorHealthActivityEvents
    // only ever reports a miss, never a hit: a page classified as
    // post-detail-classic (data-view-name present) with no [data-urn]
    // article on it is exactly what a miss looks like.
    render('<div data-view-name="feed-full-update"></div>');
    installFetchMock();

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    // A benign re-render triggers the next debounced tick, which reports
    // what the previous tick recorded.
    render('<div data-view-name="feed-full-update"></div>');
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(events.some((e) => e?.messageParams?.selector === 'feedPost')).toBe(true);
  });
});

describe('compliance boundary: this content script never crosses the line', () => {
  const source = linkedinSourceCaptureSource;

  it('never calls fetch() directly - every request goes through lib/api.ts', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('never reads cookies or localStorage/sessionStorage', () => {
    expect(source).not.toMatch(/document\.cookie/);
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/sessionStorage/);
  });

  it('never dispatches a synthetic click or submit', () => {
    expect(source).not.toMatch(/\.click\s*\(/);
    expect(source).not.toMatch(/dispatchEvent/);
    expect(source).not.toMatch(/\.submit\s*\(/);
  });

  it('never uses chrome.alarms', () => {
    expect(source).not.toMatch(/chrome\.alarms/);
  });
});
