// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import linkedinProfileCaptureSource from '../../src/content/linkedin-profile-capture.ts?raw';

const BACKEND = 'https://backend.example';
const PAIRING = { backendUrl: BACKEND, token: 't'.repeat(40) };

// No real profile-page fixture exists yet - see linkedin-dom.ts's own doc
// comment on readOwnProfile. Hand-built to mirror the shape the reader
// targets: `<main><h1>` top card plus `id="about"`/`id="experience"`
// sections, matching the fixture already used in linkedin-dom.test.ts.
const PROFILE_HTML = `
  <main>
    <section>
      <h1>Ada Lovelace</h1>
      <div>Mathematician and writer</div>
    </section>
  </main>
  <section id="about">
    <div>I write about the analytical engine and what a general-purpose computer could someday do.</div>
  </section>
`;

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

function setCanonical(href: string): void {
  document.head.innerHTML = `<link rel="canonical" href="${href}">`;
}

function render(html: string): void {
  document.body.innerHTML = html;
}

async function flushMicrotasks(times = 15) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function installFetchMock(handler: (body: unknown) => { status: number; body: unknown }) {
  const calls: unknown[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/api/extension/operator-profile')) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const result = handler(body);
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

async function importModule() {
  return await import('../../src/content/linkedin-profile-capture.js');
}

beforeEach(() => {
  // Each test's module registers a `MutationObserver` on `document.body` at
  // import time and never disconnects it (matches every other passive
  // collector in this directory). Clearing `innerHTML` leaves that same
  // `body` element in place, so a prior test's leftover observer would keep
  // firing into its own (stale) module closure. Replacing the element
  // outright detaches it.
  document.documentElement.innerHTML = '<head></head><body></body>';
  installChromeMock();
  seedPairing();
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scans once per debounce and posts the captured profile', () => {
  it('posts handle, displayName, headline and about to /api/extension/operator-profile', async () => {
    setCanonical('https://www.linkedin.com/in/ada-lovelace/');
    render(PROFILE_HTML);
    const { calls } = installFetchMock(() => ({
      status: 200,
      body: { ok: true, voiceSamplesRecorded: 0 },
    }));

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      handle: 'ada-lovelace',
      displayName: 'Ada Lovelace',
      headline: 'Mathematician and writer',
      about: expect.stringContaining('analytical engine'),
    });
  });

  it('never re-posts identical content within the same page view, even after further DOM mutation triggers a rescan', async () => {
    setCanonical('https://www.linkedin.com/in/ada-lovelace/');
    render(PROFILE_HTML);
    const { calls } = installFetchMock(() => ({
      status: 200,
      body: { ok: true, voiceSamplesRecorded: 0 },
    }));

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    // A benign re-render (LinkedIn's own client-side routing repaints the
    // same top card) triggers the MutationObserver but must not resend the
    // exact same payload.
    render(PROFILE_HTML);
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
  });

  it('sends a fresh request once the rendered content actually changes', async () => {
    setCanonical('https://www.linkedin.com/in/ada-lovelace/');
    render(PROFILE_HTML);
    const { calls } = installFetchMock(() => ({
      status: 200,
      body: { ok: true, voiceSamplesRecorded: 0 },
    }));

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    render(
      PROFILE_HTML.replace('Mathematician and writer', 'Mathematician, writer, and programmer'),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
  });

  it('never sends anything when the page carries no handle at all', async () => {
    render('<main><div>not a profile page</div></main>');
    const { calls } = installFetchMock(() => ({
      status: 200,
      body: { ok: true, voiceSamplesRecorded: 0 },
    }));

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(calls).toHaveLength(0);
  });

  it('logs activity.linkedin-collector.voice-samples-captured with the server-reported count', async () => {
    setCanonical('https://www.linkedin.com/in/ada-lovelace/');
    render(
      PROFILE_HTML +
        `<div role="article" data-urn="urn:li:activity:1111">
          <div class="update-components-text">A post about the analytical engine.</div>
        </div>`,
    );
    installFetchMock(() => ({ status: 200, body: { ok: true, voiceSamplesRecorded: 1 } }));

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'info',
        source: 'linkedin-collector',
        message: 'activity.linkedin-collector.voice-samples-captured',
        messageParams: { count: 1 },
      }),
    );
  });
});

describe('server refusal', () => {
  it('logs a refused capture through logFromContent instead of throwing', async () => {
    setCanonical('https://www.linkedin.com/in/someone-else/');
    render(PROFILE_HTML);
    installFetchMock(() => ({ status: 200, body: { ok: false, refused: 'not_your_profile' } }));

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'info',
        source: 'linkedin-collector',
        message: 'activity.linkedin-collector.profile-refused',
        messageParams: { reason: 'not_your_profile' },
      }),
    );
  });
});

describe('a failed request is logged, not thrown', () => {
  it('logs activity.linkedin-collector.profile-failed on a network error', async () => {
    setCanonical('https://www.linkedin.com/in/ada-lovelace/');
    render(PROFILE_HTML);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        source: 'linkedin-collector',
        message: 'activity.linkedin-collector.profile-failed',
        messageParams: { reason: 'network down' },
      }),
    );
  });
});

describe('compliance boundary: this content script never crosses the line', () => {
  const source = linkedinProfileCaptureSource;

  it('never fetches or navigates toward linkedin.com/licdn.com itself', () => {
    // The one fetch() call in this file targets `pairing.backendUrl`, built
    // from an identifier (OPERATOR_PROFILE_PATH) rather than a literal
    // mentioning "linkedin" in the call expression text - see the module's
    // own comment on this.
    const fetchCalls = source.match(/fetch\(([^)]*)\)/g) ?? [];
    for (const call of fetchCalls) expect(call).not.toMatch(/linkedin|licdn/i);
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
