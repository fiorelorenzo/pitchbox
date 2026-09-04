// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import linkedinObserveSource from '../../src/content/linkedin-observe.ts?raw';
// Real, anonymised captures - see fixtures/linkedin/README.md. feed.html is
// the SDUI frontend (no dedupable identifier anywhere); post-detail.html is
// the classic frontend with exactly one urn-bearing post.
import FEED_HTML from './fixtures/linkedin/feed.html?raw';
import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';

const BACKEND = 'https://backend.example';
const PAIRING = { backendUrl: BACKEND, token: 't'.repeat(40) };
const PROJECT_ID = 7;

type AssistState = {
  enabled: boolean;
  collectorEnabled: boolean;
  killSwitch: boolean;
  projectId: number | null;
  dailyCommentCap: number;
  dailyPostCap: number;
};

function assistState(overrides: Partial<AssistState> = {}): AssistState {
  return {
    enabled: true,
    collectorEnabled: true,
    killSwitch: false,
    projectId: PROJECT_ID,
    dailyCommentCap: 8,
    dailyPostCap: 1,
    ...overrides,
  };
}

/** jsdom has no IntersectionObserver - stand-in that lets a test fire
 * intersection entries on demand, the same way the real one would once a
 * post it is watching actually scrolls into the viewport. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed = new Set<Element>();
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** Test helper: report an intersection for `target`, whether or not it is
   * still tracked in `observed` - mirrors a real IntersectionObserver batch
   * that can report the same target more than once in its lifetime. */
  fire(target: Element, isIntersecting = true) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

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
        async remove(keys: string[] | string) {
          const k = Array.isArray(keys) ? keys : [keys];
          for (const x of k) delete (this._s as any)[x];
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

/** Flush pending promise microtasks without depending on real/fake timers. */
async function flushMicrotasks(times = 15) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function render(html: string) {
  document.body.innerHTML = html;
}

type ObservationsBody = { platform: string; projectId: number; items: unknown[] };
type ObservationsHandler = (body: ObservationsBody) => { status: number; body: unknown };

function installFetchMock(opts: { assist: AssistState; onObservations?: ObservationsHandler }) {
  let assist = opts.assist;
  const observationCalls: ObservationsBody[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/extension/linkedin-assist')) {
      return new Response(JSON.stringify({ assist }), { status: 200 });
    }
    if (url.endsWith('/api/extension/observations')) {
      const body = JSON.parse(String(init?.body)) as ObservationsBody;
      observationCalls.push(body);
      const result = opts.onObservations
        ? opts.onObservations(body)
        : {
            status: 200,
            body: { ok: true, inserted: body.items.length, duplicates: 0, dropped: 0 },
          };
      return new Response(JSON.stringify(result.body), { status: result.status });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, observationCalls, setAssist: (next: AssistState) => (assist = next) };
}

async function importModule() {
  return await import('../../src/content/linkedin-observe.js');
}

beforeEach(() => {
  document.body.innerHTML = '';
  installChromeMock();
  seedPairing();
  FakeIntersectionObserver.instances = [];
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('off by default: the collector does nothing until enabled and bound', () => {
  it('never observes the DOM and never posts when the server says the collector is disabled', async () => {
    render(POST_DETAIL_HTML);
    const { mock, observationCalls } = installFetchMock({
      assist: assistState({ enabled: false, collectorEnabled: false, projectId: null }),
    });
    await importModule();
    await flushMicrotasks();

    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(observationCalls).toHaveLength(0);
    // The only fetch made is the read path itself, never observations.
    expect(mock.mock.calls.every((c) => String(c[0]).endsWith('/linkedin-assist'))).toBe(true);
  });
});

describe('feed.html (SDUI frontend, real capture): no dedupable identifier anywhere', () => {
  it('reads every rendered post but never queues or sends an observation for it', async () => {
    render(FEED_HTML);
    const { observationCalls } = installFetchMock({ assist: assistState() });
    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    const io = FakeIntersectionObserver.instances[0];
    expect(io.observed.size).toBeGreaterThan(0);
    for (const post of Array.from(io.observed)) io.fire(post, true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20_000);
    await flushMicrotasks();

    expect(observationCalls).toHaveLength(0);
  });
});

describe('post-detail.html (classic frontend, real capture): the one urn-bearing post', () => {
  it('is queued and sent as exactly one observation with the read urn, author, text and url', async () => {
    render(POST_DETAIL_HTML);
    const { observationCalls } = installFetchMock({ assist: assistState() });
    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    const io = FakeIntersectionObserver.instances[0];
    expect(io.observed.size).toBe(1);
    const [post] = Array.from(io.observed);
    io.fire(post, true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(observationCalls).toHaveLength(1);
    expect(observationCalls[0].platform).toBe('linkedin');
    expect(observationCalls[0].projectId).toBe(PROJECT_ID);
    expect(observationCalls[0].items).toHaveLength(1);
    const item = observationCalls[0].items[0] as Record<string, unknown>;
    expect(item.externalId).toBe('urn:li:activity:7000000000000000001');
    expect(item.authorHandle).toBe('example-person');
    expect(item.authorName).toBe('Giulia Bianchi');
    expect(item.text).toMatch(/ingest path/);
    expect(item.url).toBe(window.location.href);
    expect(typeof item.observedAt).toBe('string');
    expect(Number.isNaN(Date.parse(item.observedAt as string))).toBe(false);
  });

  it('a post seen twice yields one observation (session-level dedupe)', async () => {
    render(POST_DETAIL_HTML);
    const { observationCalls } = installFetchMock({ assist: assistState() });
    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    const io = FakeIntersectionObserver.instances[0];
    const [post] = Array.from(io.observed);
    // Fired twice for the same target before the batch flushes - the same
    // shape a real IntersectionObserver produces for a post that scrolled
    // out and back into view before this script's own unobserve() lands.
    io.fire(post, true);
    io.fire(post, true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(observationCalls).toHaveLength(1);
    expect(observationCalls[0].items).toHaveLength(1);
  });
});

describe('a 403 is authoritative: it stops the collector, not just the batch', () => {
  it('never posts again this session once the server refuses with kill_switch', async () => {
    render(POST_DETAIL_HTML);
    const { observationCalls } = installFetchMock({
      assist: assistState(),
      onObservations: () => ({ status: 403, body: { message: 'kill_switch' } }),
    });
    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    const io = FakeIntersectionObserver.instances[0];
    const [post] = Array.from(io.observed);
    io.fire(post, true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(observationCalls).toHaveLength(1);
    const events = loggedEvents();
    expect(
      events.some(
        (e) =>
          e.source === 'linkedin-collector' &&
          e.message === 'activity.linkedin-collector.stopped' &&
          e.messageParams?.reason === 'kill_switch',
      ),
    ).toBe(true);

    // A further intersection report after the stop must produce no request.
    io.fire(post, true);
    await vi.advanceTimersByTimeAsync(20_000);
    await flushMicrotasks();
    expect(observationCalls).toHaveLength(1);
  });

  it('maps collector_disabled and project_not_bound the same way', async () => {
    for (const reason of ['collector_disabled', 'project_not_bound']) {
      document.body.innerHTML = '';
      installChromeMock();
      seedPairing();
      FakeIntersectionObserver.instances = [];
      vi.resetModules();
      render(POST_DETAIL_HTML);
      const { observationCalls } = installFetchMock({
        assist: assistState(),
        onObservations: () => ({ status: 403, body: { message: reason } }),
      });
      vi.useFakeTimers();
      await importModule();
      await flushMicrotasks();
      const io = FakeIntersectionObserver.instances[0];
      const [post] = Array.from(io.observed);
      io.fire(post, true);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(3_000);
      await flushMicrotasks();

      expect(observationCalls).toHaveLength(1);
      const events = loggedEvents();
      expect(
        events.some(
          (e) =>
            e.message === 'activity.linkedin-collector.stopped' &&
            e.messageParams?.reason === reason,
        ),
      ).toBe(true);
      vi.useRealTimers();
    }
  });
});

describe('poll cadence: an already-active collector notices a kill switch flip on its own', () => {
  it('stops after the next assist poll, without needing a batch attempt at all', async () => {
    render(POST_DETAIL_HTML);
    const { observationCalls, setAssist } = installFetchMock({ assist: assistState() });
    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    setAssist(assistState({ enabled: false, collectorEnabled: false, killSwitch: true }));
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(
      events.some(
        (e) =>
          e.message === 'activity.linkedin-collector.stopped' &&
          e.messageParams?.reason === 'kill_switch',
      ),
    ).toBe(true);
    // Never even attempted a batch - the poll caught it first.
    expect(observationCalls).toHaveLength(0);
  });
});

describe('selector health: forwarded through logFromContent, not swallowed', () => {
  it('logs an activity.linkedin-dom.selector-miss event when the author selector breaks', async () => {
    // readPostAuthor's classic-frontend selector (`a[href] [aria-hidden="true"]`)
    // falls through to whichever `[aria-hidden="true"]` element inside the
    // byline anchor it finds first - the fixture's byline anchor nests
    // three of them (name, connection-degree marker, and a visually-hidden
    // duplicate of the post text), so clearing only the name span's
    // attribute still leaves the selector matching the next one. Strip the
    // attribute everywhere, leaving the urn-bearing article (and so
    // findFeedPosts/readPostIdentifier) untouched.
    const broken = POST_DETAIL_HTML.replaceAll('aria-hidden="true"', 'data-hidden-decoy="true"');
    expect(broken).not.toBe(POST_DETAIL_HTML);
    render(broken);
    installFetchMock({ assist: assistState() });
    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    const io = FakeIntersectionObserver.instances[0];
    const [post] = Array.from(io.observed);
    io.fire(post, true);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(
      events.some(
        (e) =>
          e.source === 'linkedin-dom' &&
          e.message === 'activity.linkedin-dom.selector-miss' &&
          e.messageParams?.selector === 'postAuthor',
      ),
    ).toBe(true);
  });
});

describe('compliance boundary: this content script never crosses the line', () => {
  // Mirrors linkedin-dom.test.ts's and linkedin-comment.test.ts's own
  // boundary checks over their own source text.
  const source = linkedinObserveSource;

  it('never fetches linkedin.com or reads its cookies/storage', () => {
    expect(source).not.toMatch(/fetch\s*\(\s*['"`]https?:\/\/[^'"`]*linkedin\.com/);
    expect(source).not.toMatch(/document\.cookie/);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
    expect(source).not.toMatch(/chrome\.alarms/);
  });

  it('never dispatches a synthetic click or submit, and never calls .click()/.submit()', () => {
    expect(source).not.toMatch(/\.click\s*\(/);
    expect(source).not.toMatch(/\.submit\s*\(/);
    expect(source).not.toMatch(/dispatchEvent/);
  });
});
