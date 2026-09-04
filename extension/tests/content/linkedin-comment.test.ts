// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import linkedinCommentSource from '../../src/content/linkedin-comment.ts?raw';

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

function setUrl(pathAndSearch: string) {
  window.history.pushState({}, '', pathAndSearch);
}

/** Flush pending promise microtasks without depending on real/fake timers. */
async function flushMicrotasks(times = 15) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function importModule() {
  return await import('../../src/content/linkedin-comment.js');
}

function loggedEvents(): Array<Record<string, any>> {
  const fn = (globalThis as any).chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
  return fn.mock.calls.map((args: any[]) => args[0]?.event);
}

const DRAFT_ID = 42;
const ACTIVITY_URN = 'urn:li:activity:7000000000000000001';
const OUR_COMMENT_URN = 'urn:li:comment:(activity:7000000000000000001,9999999999999999999)';
const DRAFT_URL_PATH = `/feed/update/${ACTIVITY_URN}/?pitchbox_draft=${DRAFT_ID}&pitchbox_backend=${encodeURIComponent(BACKEND)}`;

type FetchOverrides = {
  version?: number;
  /** First POST .../sent answers 409 version_conflict; the second succeeds. */
  conflictOnce?: boolean;
};

/**
 * Draft GET + armed/sent, keyed by URL suffix - same shape as
 * post-comment.test.ts's own installFetchMock, extended with a
 * `conflictOnce` toggle to exercise api.ts's built-in 409 refetch-and-retry.
 */
function installFetchMock(overrides: FetchOverrides = {}) {
  const version = overrides.version ?? 3;
  let sentCalls = 0;
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.endsWith('/armed')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith('/sent')) {
      sentCalls++;
      if (overrides.conflictOnce && sentCalls === 1) {
        return new Response(
          JSON.stringify({ error: 'version_conflict', current_version: version + 1 }),
          {
            status: 409,
          },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (/\/draft\/\d+$/.test(url)) {
      // Once a conflict has been reported, the refetch inside api.sent()
      // must see the bumped version.
      const currentVersion = overrides.conflictOnce && sentCalls >= 1 ? version + 1 : version;
      return new Response(
        JSON.stringify({
          id: DRAFT_ID,
          kind: 'post_comment',
          state: 'pending_review',
          body: 'draft body text',
          targetUser: null,
          version: currentVersion,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function installClipboardMock() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  window.history.pushState({}, '', '/');
  installChromeMock();
  installClipboardMock();
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('insertComposerText', () => {
  it('writes textContent and fires a real input event carrying inputType/data', async () => {
    const { insertComposerText } = await importModule();
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.setAttribute('role', 'textbox');
    document.body.appendChild(div);
    const seen: InputEvent[] = [];
    div.addEventListener('input', (e) => seen.push(e as InputEvent));

    insertComposerText(div, 'a drafted comment');

    expect(div.textContent).toBe('a drafted comment');
    expect(seen).toHaveLength(1);
    expect(seen[0].inputType).toBe('insertText');
    expect(seen[0].data).toBe('a drafted comment');
    expect(seen[0].bubbles).toBe(true);
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
    div.textContent = 'Something went wrong. Please try again.';
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
});

describe('findOurCommentUrn', () => {
  it('finds a comment article outside the baseline whose text matches', async () => {
    const { findOurCommentUrn } = await importModule();
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = 'draft body text';
    document.body.appendChild(article);

    expect(findOurCommentUrn('draft body text', new Set())).toBe(OUR_COMMENT_URN);
  });

  it('ignores an article already present in the baseline (pre-existing comment)', async () => {
    const { findOurCommentUrn } = await importModule();
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = 'draft body text';
    document.body.appendChild(article);

    expect(findOurCommentUrn('draft body text', new Set([OUR_COMMENT_URN]))).toBeUndefined();
  });

  it('ignores a new article whose text does not match', async () => {
    const { findOurCommentUrn } = await importModule();
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = 'someone else entirely';
    document.body.appendChild(article);

    expect(findOurCommentUrn('draft body text', new Set())).toBeUndefined();
  });

  it('collapses whitespace before comparing', async () => {
    const { findOurCommentUrn } = await importModule();
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = '  draft   body\n  text  ';
    document.body.appendChild(article);

    expect(findOurCommentUrn('draft body text', new Set())).toBe(OUR_COMMENT_URN);
  });
});

describe('offer give-up: composer missing', () => {
  it('logs a warn with a distinct reason when the comment composer cannot be found', async () => {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    installFetchMock();
    // A submit button is present (so wireSubmit succeeds synchronously and no
    // MutationObserver/timeout gets scheduled) but no composer.
    const btn = document.createElement('button');
    btn.setAttribute('type', 'submit');
    document.body.appendChild(btn);

    await importModule();
    await flushMicrotasks();

    const events = loggedEvents();
    const warn = events.find((e) => e.message === 'activity.linkedin-action.composer-missing');
    expect(warn).toBeDefined();
    expect(warn?.level).toBe('warn');
    expect(warn?.messageParams).toEqual({ draftId: DRAFT_ID });
    expect(warn?.meta).toMatchObject({ draftId: DRAFT_ID, reason: 'comment-composer-not-found' });
  });
});

describe('composer insert: only on an explicit human click', () => {
  // A submit button is present too (so wireSubmit succeeds synchronously and
  // no MutationObserver/15s timeout gets scheduled - same technique as the
  // "composer missing" give-up test above; leaving it out would leak a real
  // setTimeout and an undisconnected observer past this test's own lifetime).
  function buildComposer(): HTMLElement {
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.setAttribute('role', 'textbox');
    document.body.appendChild(composer);
    const btn = document.createElement('button');
    btn.setAttribute('type', 'submit');
    document.body.appendChild(btn);
    return composer;
  }

  it('does not insert anything before the composer is clicked', async () => {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    installFetchMock();
    const composer = buildComposer();

    await importModule();
    await flushMicrotasks();

    expect(composer.textContent).toBe('');
  });

  it('inserts the draft body and copies it to the clipboard on the first click', async () => {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    installFetchMock();
    const writeText = installClipboardMock();
    const composer = buildComposer();

    await importModule();
    await flushMicrotasks();

    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    expect(composer.textContent).toBe('draft body text');
    expect(writeText).toHaveBeenCalledWith('draft body text');
  });

  it('never overwrites text the human already typed themselves', async () => {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    installFetchMock();
    const composer = buildComposer();
    composer.textContent = "human's own words";

    await importModule();
    await flushMicrotasks();

    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    expect(composer.textContent).toBe("human's own words");
  });
});

describe('wireSubmit completion detection', () => {
  async function setUpArmedDraft(overrides: FetchOverrides = {}) {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    const fetchMock = installFetchMock(overrides);
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.setAttribute('role', 'textbox');
    document.body.appendChild(composer);
    const btn = document.createElement('button');
    btn.setAttribute('type', 'submit');
    document.body.appendChild(btn);

    await importModule();
    await flushMicrotasks();

    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();
    expect(composer.textContent).toBe('draft body text');

    vi.useFakeTimers();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const armedCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/armed'));
    expect(armedCalls.length).toBe(1);

    return { composer, btn, fetchMock };
  }

  it('flips the draft to sent once the composer clears and our comment node appears with no error', async () => {
    const { composer, fetchMock } = await setUpArmedDraft();

    composer.textContent = '';
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = 'draft body text';
    document.body.appendChild(article);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    const sentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sent'));
    expect(sentCalls.length).toBe(1);
    const body = JSON.parse(String((sentCalls[0][1] as RequestInit).body));
    expect(body.sentContent).toBe('draft body text');
    expect(body.platformPostId).toBe(OUR_COMMENT_URN);
    expect(body.version).toBe(3);
    expect(body.platformCommentId).toBeUndefined();

    const events = loggedEvents();
    expect(
      events.some(
        (e) =>
          e.message === 'activity.linkedin-action.comment-sent' &&
          e.messageParams?.draftId === DRAFT_ID,
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.message === 'activity.linkedin-action.comment-confirm-timeout'),
    ).toBe(false);
  });

  it('does NOT flip to sent when the composer clears but an inline error banner is visible', async () => {
    const { composer, fetchMock } = await setUpArmedDraft();

    composer.textContent = '';
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'Something went wrong. Please try again.';
    document.body.appendChild(alert);
    // A comment node with our text is present too - proves the error banner
    // alone is what blocks completion, not merely a missing match.
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = 'draft body text';
    document.body.appendChild(article);

    // Poll for a while - well short of the 20s give-up window.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    }

    const sentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sent'));
    expect(sentCalls.length).toBe(0);
    expect(loggedEvents().some((e) => e.message === 'activity.linkedin-action.comment-sent')).toBe(
      false,
    );
  });

  it('retries once after a 409 version conflict, refetching the draft and resending with the new version', async () => {
    const { composer, fetchMock } = await setUpArmedDraft({ conflictOnce: true });

    composer.textContent = '';
    const article = document.createElement('article');
    article.setAttribute('data-id', OUR_COMMENT_URN);
    article.textContent = 'draft body text';
    document.body.appendChild(article);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    const sentCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sent'));
    expect(sentCalls.length).toBe(2);
    const firstBody = JSON.parse(String((sentCalls[0][1] as RequestInit).body));
    const secondBody = JSON.parse(String((sentCalls[1][1] as RequestInit).body));
    expect(firstBody.version).toBe(3);
    expect(secondBody.version).toBe(4);

    const draftGetCalls = fetchMock.mock.calls.filter((c) => /\/draft\/\d+$/.test(String(c[0])));
    // Once at init() and once more inside api.sent()'s 409 refetch.
    expect(draftGetCalls.length).toBe(2);

    expect(loggedEvents().some((e) => e.message === 'activity.linkedin-action.comment-sent')).toBe(
      true,
    );
  });

  it('gives up with a distinct error after 20s with no confirmed completion, and never marks sent', async () => {
    const { fetchMock } = await setUpArmedDraft();

    // Composer never clears and no comment node ever appears.
    for (let i = 0; i < 39; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    }
    expect(
      loggedEvents().some((e) => e.message === 'activity.linkedin-action.comment-confirm-timeout'),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    const events = loggedEvents();
    const giveUp = events.find(
      (e) => e.message === 'activity.linkedin-action.comment-confirm-timeout',
    );
    expect(giveUp).toBeDefined();
    expect(giveUp?.level).toBe('error');
    expect(giveUp?.messageParams).toEqual({ draftId: DRAFT_ID });
    expect(giveUp?.meta).toMatchObject({ draftId: DRAFT_ID, reason: 'click-poll-timeout' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/sent'))).toBe(false);
  });
});

describe('wireSubmit MutationObserver timeout', () => {
  it('logs a warn with a distinct reason when no submit button ever appears', async () => {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    installFetchMock();
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.setAttribute('role', 'textbox');
    document.body.appendChild(composer);

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    const events = loggedEvents();
    const warn = events.find(
      (e) => e.message === 'activity.linkedin-action.comment-submit-not-found',
    );
    expect(warn).toBeDefined();
    expect(warn?.level).toBe('warn');
    expect(warn?.messageParams).toEqual({ draftId: DRAFT_ID });
    expect(warn?.meta).toMatchObject({ draftId: DRAFT_ID, reason: 'submit-button-not-found' });
  });

  it('does not log the timeout warn once a submit button appears in time', async () => {
    setUrl(DRAFT_URL_PATH);
    seedPairing();
    installFetchMock();
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.setAttribute('role', 'textbox');
    document.body.appendChild(composer);

    vi.useFakeTimers();
    await importModule();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    const btn = document.createElement('button');
    btn.setAttribute('type', 'submit');
    document.body.appendChild(btn);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    const events = loggedEvents();
    expect(
      events.some((e) => e.message === 'activity.linkedin-action.comment-submit-not-found'),
    ).toBe(false);
  });
});

describe('compliance boundary: this content script never dispatches a synthetic click or submit', () => {
  // Mirrors linkedin-dom.test.ts's own boundary check. This module DOES
  // dispatch a synthetic `input` event (see insertComposerText's doc
  // comment - the design explicitly carves that out), so this only checks
  // for the patterns the design forbids outright.
  const source = linkedinCommentSource;

  it('never calls .click() or .submit()', () => {
    expect(source).not.toMatch(/\.click\s*\(/);
    expect(source).not.toMatch(/\.submit\s*\(/);
  });

  it('never dispatches a synthetic click or submit event', () => {
    expect(source).not.toMatch(/dispatchEvent\([^)]*(?:MouseEvent|SubmitEvent)/);
  });

  it('never fetches linkedin.com or reads its cookies/storage', () => {
    expect(source).not.toMatch(/fetch\s*\(\s*['"`]https?:\/\/[^'"`]*linkedin\.com/);
    expect(source).not.toMatch(/document\.cookie/);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
    expect(source).not.toMatch(/chrome\.alarms/);
  });
});
