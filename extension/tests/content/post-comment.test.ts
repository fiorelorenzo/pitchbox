// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const BACKEND = 'https://backend.example';
const PAIRING = { backendUrl: BACKEND, token: 't'.repeat(40) };

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
    runtime: {
      sendMessage: vi.fn(),
    },
  };
}

function seedPairing() {
  ((globalThis as any).chrome.storage.local as any)._s = { pairings: [PAIRING] };
}

// Relative pushState resolves against the current (default jsdom) origin, so
// this works regardless of what that origin actually is and never trips
// jsdom's cross-origin pushState guard.
function setUrl(pathAndSearch: string) {
  window.history.pushState({}, '', pathAndSearch);
}

/** Flush pending promise microtasks without depending on real/fake timers. */
async function flushMicrotasks(times = 15) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function importModule() {
  return await import('../../src/content/post-comment.js');
}

function loggedEvents(): Array<Record<string, any>> {
  const fn = (globalThis as any).chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
  return fn.mock.calls.map((args: any[]) => args[0]?.event);
}

/** Draft GET/armed/sent + Reddit's own /api/me.json, keyed by URL suffix. */
function installFetchMock() {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/me.json')) {
      return new Response(JSON.stringify({}), { status: 401 });
    }
    if (url.endsWith('/armed')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith('/sent')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (/\/draft\/\d+$/.test(url)) {
      return new Response(
        JSON.stringify({
          id: 42,
          kind: 'comment',
          state: 'drafted',
          body: 'draft body text',
          targetUser: null,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  window.history.pushState({}, '', '/');
  installChromeMock();
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('derivePostId', () => {
  it('extracts the post id from a canonical /comments/ URL', async () => {
    const { derivePostId } = await importModule();
    expect(derivePostId('/r/test/comments/abc123/some_title/')).toBe('abc123');
  });

  it('matches without a trailing slug segment', async () => {
    const { derivePostId } = await importModule();
    expect(derivePostId('/r/test/comments/abc123')).toBe('abc123');
  });

  it('is case-insensitive on the id segment', async () => {
    const { derivePostId } = await importModule();
    expect(derivePostId('/r/test/comments/ABC123/x/')).toBe('ABC123');
  });

  it('returns null when the path has no /comments/ segment', async () => {
    const { derivePostId } = await importModule();
    expect(derivePostId('/r/test/submit')).toBeNull();
  });
});

describe('setValueCompat', () => {
  it('sets a <textarea> value through the native setter and fires input', async () => {
    const { setValueCompat } = await importModule();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const seen: string[] = [];
    ta.addEventListener('input', () => seen.push(ta.value));

    setValueCompat(ta, 'hello world');

    expect(ta.value).toBe('hello world');
    expect(seen).toEqual(['hello world']);
  });

  it('sets textContent and fires input on a non-textarea (contenteditable) element', async () => {
    const { setValueCompat } = await importModule();
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    let fired = 0;
    div.addEventListener('input', () => fired++);

    setValueCompat(div, 'a comment');

    expect(div.textContent).toBe('a comment');
    expect(fired).toBe(1);
  });
});

describe('hasInlineCommentError', () => {
  it('is false when no error markup is present', async () => {
    const { hasInlineCommentError } = await importModule();
    expect(hasInlineCommentError()).toBe(false);
  });

  it('is true for a visible role="alert" element', async () => {
    const { hasInlineCommentError } = await importModule();
    const div = document.createElement('div');
    div.setAttribute('role', 'alert');
    div.textContent = 'You are doing that too much. Try again later.';
    document.body.appendChild(div);

    expect(hasInlineCommentError()).toBe(true);
  });

  it('ignores an empty role="alert" element', async () => {
    const { hasInlineCommentError } = await importModule();
    const div = document.createElement('div');
    div.setAttribute('role', 'alert');
    document.body.appendChild(div);

    expect(hasInlineCommentError()).toBe(false);
  });

  it('is true for a legacy non-empty .error element (old Reddit)', async () => {
    const { hasInlineCommentError } = await importModule();
    const span = document.createElement('span');
    span.className = 'error';
    span.textContent = 'this comment was removed';
    document.body.appendChild(span);

    expect(hasInlineCommentError()).toBe(true);
  });

  it('scopes the check to the given root', async () => {
    const { hasInlineCommentError } = await importModule();
    const scoped = document.createElement('div');
    document.body.appendChild(scoped);
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'error outside the scoped root';
    document.body.appendChild(alert);

    expect(hasInlineCommentError(scoped)).toBe(false);
    expect(hasInlineCommentError()).toBe(true);
  });
});

describe('fill() give-up (#173)', () => {
  it('logs a warn with a distinct reason when the comment box cannot be found', async () => {
    setUrl(
      `/r/test/comments/abc123/title/?pitchbox_draft=42&pitchbox_backend=${encodeURIComponent(BACKEND)}`,
    );
    seedPairing();
    installFetchMock();
    // A submit button is present (so wireSubmit succeeds synchronously and no
    // MutationObserver/timeout gets scheduled) but no textarea/contenteditable.
    const btn = document.createElement('button');
    btn.textContent = 'Comment';
    document.body.appendChild(btn);

    await importModule();
    await flushMicrotasks();

    const events = loggedEvents();
    const warn = events.find((e) => e.message === 'activity.reddit-action.comment-box-missing');
    expect(warn).toBeDefined();
    expect(warn?.level).toBe('warn');
    expect(warn?.messageParams).toEqual({ draftId: 42 });
    expect(warn?.meta).toMatchObject({ draftId: 42, reason: 'comment-textarea-not-found' });
  });
});

describe('wireSubmit success/failure detection (#181)', () => {
  async function setUpArmedDraft() {
    setUrl(
      `/r/test/comments/abc123/title/?pitchbox_draft=42&pitchbox_backend=${encodeURIComponent(BACKEND)}`,
    );
    seedPairing();
    const fetchMock = installFetchMock();
    const ta = document.createElement('textarea');
    ta.setAttribute('name', 'text');
    document.body.appendChild(ta);
    const btn = document.createElement('button');
    btn.textContent = 'Comment';
    document.body.appendChild(btn);

    await importModule();
    await flushMicrotasks();
    // fill() should have prefilled the box from the draft.
    expect(ta.value).toBe('draft body text');

    vi.useFakeTimers();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    return { ta, btn, fetchMock };
  }

  it('flips the draft to sent when the textarea clears with no inline error', async () => {
    const { ta, fetchMock } = await setUpArmedDraft();

    ta.value = '';
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    const sentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sent'));
    expect(sentCalls.length).toBe(1);
    const events = loggedEvents();
    expect(
      events.some(
        (e) =>
          e.message === 'activity.reddit-action.comment-sent' && e.messageParams?.draftId === 42,
      ),
    ).toBe(true);
    expect(events.some((e) => e.message === 'activity.reddit-action.comment-confirm-timeout')).toBe(
      false,
    );
  });

  it('does NOT flip to sent when the textarea clears but an inline error banner is visible', async () => {
    const { ta, fetchMock } = await setUpArmedDraft();

    ta.value = '';
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'You are doing that too much. Try again later.';
    document.body.appendChild(alert);

    // Poll for a while - well short of the 20s give-up window.
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    }

    const sentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sent'));
    expect(sentCalls.length).toBe(0);
    expect(loggedEvents().some((e) => e.message === 'activity.reddit-action.comment-sent')).toBe(
      false,
    );
  });

  it('does NOT flip to sent from a rising comment count alone (dropped heuristic, #181)', async () => {
    const { fetchMock } = await setUpArmedDraft();
    // Leave the textarea untouched (still filled) - only the surrounding
    // thread changes, as on a busy/live-updating page.
    for (let i = 0; i < 5; i++) {
      const el = document.createElement('div');
      el.setAttribute('data-testid', `comment-${i}`);
      document.body.appendChild(el);
    }

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    }

    const sentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sent'));
    expect(sentCalls.length).toBe(0);
  });

  it('gives up with a distinct error after 20s with no confirmed completion (#173)', async () => {
    const { ta, fetchMock } = await setUpArmedDraft();

    // Textarea never clears and nothing else confirms completion.
    void ta;
    for (let i = 0; i < 39; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    }
    expect(
      loggedEvents().some((e) => e.message === 'activity.reddit-action.comment-confirm-timeout'),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    const events = loggedEvents();
    const giveUp = events.find(
      (e) => e.message === 'activity.reddit-action.comment-confirm-timeout',
    );
    expect(giveUp).toBeDefined();
    expect(giveUp?.level).toBe('error');
    expect(giveUp?.messageParams).toEqual({ draftId: 42 });
    expect(giveUp?.meta).toMatchObject({ draftId: 42, reason: 'click-poll-timeout' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/sent'))).toBe(false);
  });
});

describe('wireSubmit MutationObserver timeout (#173)', () => {
  it('logs a warn with a distinct reason when no submit button ever appears', async () => {
    setUrl(
      `/r/test/comments/abc123/title/?pitchbox_draft=42&pitchbox_backend=${encodeURIComponent(BACKEND)}`,
    );
    seedPairing();
    installFetchMock();
    // A textarea is present (so fill() succeeds quietly) but no button, so
    // wireSubmit() never finds a target and init() falls back to the
    // MutationObserver + 15s timeout path.
    const ta = document.createElement('textarea');
    ta.setAttribute('name', 'text');
    document.body.appendChild(ta);

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    const events = loggedEvents();
    const warn = events.find(
      (e) => e.message === 'activity.reddit-action.comment-submit-not-found',
    );
    expect(warn).toBeDefined();
    expect(warn?.level).toBe('warn');
    expect(warn?.messageParams).toEqual({ draftId: 42 });
    expect(warn?.meta).toMatchObject({ draftId: 42, reason: 'submit-button-not-found' });
  });

  it('does not log the timeout warn once a submit button appears in time', async () => {
    setUrl(
      `/r/test/comments/abc123/title/?pitchbox_draft=42&pitchbox_backend=${encodeURIComponent(BACKEND)}`,
    );
    seedPairing();
    installFetchMock();
    const ta = document.createElement('textarea');
    ta.setAttribute('name', 'text');
    document.body.appendChild(ta);

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    const btn = document.createElement('button');
    btn.textContent = 'Comment';
    document.body.appendChild(btn);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(
      events.some((e) => e.message === 'activity.reddit-action.comment-submit-not-found'),
    ).toBe(false);
  });
});
