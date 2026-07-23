// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.reddit.com/message/compose?pitchbox_draft=42"}
import { describe, it, expect, beforeEach, vi } from 'vitest';

(globalThis as any).chrome = {
  storage: {
    local: {
      _s: {} as Record<string, unknown>,
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in (this._s as any)) out[k] = (this._s as any)[k];
        return out;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(this._s as any, patch);
      },
      async remove(keys: string[]) {
        for (const k of keys) delete (this._s as any)[k];
      },
    },
  },
  runtime: {
    sendMessage: vi.fn(),
  },
};

const PAIRING = { backendUrl: 'http://example.test', token: 'x'.repeat(64) };

function setPairing() {
  ((globalThis as any).chrome.storage.local as any)._s.pairings = [PAIRING];
}

function setComposeDom() {
  document.body.innerHTML = `
    <textarea name="text"></textarea>
    <button type="submit">Send</button>
  `;
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector('textarea[name="text"]') as HTMLTextAreaElement;
}

function sendButton(): HTMLButtonElement {
  return document.querySelector('button[type="submit"]') as HTMLButtonElement;
}

function makeFetchMock(opts: { draftBody?: string; getDraftOk?: boolean; sentOk?: boolean } = {}) {
  const { draftBody = 'hello there', getDraftOk = true, sentOk = true } = opts;
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/armed')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (path.endsWith('/sent')) {
      return sentOk
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response('boom', { status: 500 });
    }
    // GET /api/extension/draft/:id
    return getDraftOk
      ? new Response(
          JSON.stringify({
            id: 42,
            kind: 'dm',
            state: 'approved',
            body: draftBody,
            targetUser: 'bob',
          }),
          { status: 200 },
        )
      : new Response('not found', { status: 404 });
  });
}

// Flush the microtask queue enough times for an awaited fetch -> json chain
// to settle. Independent of the fake-timer clock (Promise microtasks aren't
// part of it), so this is safe to call whether or not fake timers are active.
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  ((globalThis as any).chrome.storage.local as any)._s = {};
  (globalThis as any).chrome.runtime.sendMessage.mockClear();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

async function importModule() {
  return await import('../../src/content/dm-compose.js');
}

function logCallsFor(message: string) {
  return (globalThis as any).chrome.runtime.sendMessage.mock.calls.filter(
    ([msg]: [any]) => msg?.event?.message === message,
  );
}

describe('dm-compose auto-fill (#206)', () => {
  it('fills the empty compose textarea with the draft body', async () => {
    setPairing();
    setComposeDom();
    vi.stubGlobal('fetch', makeFetchMock({ draftBody: 'auto-filled body' }));

    await importModule();
    await flush();

    expect(textarea().value).toBe('auto-filled body');
  });

  it('does not overwrite text the user already typed', async () => {
    setPairing();
    setComposeDom();
    textarea().value = 'already typed by the user';
    vi.stubGlobal('fetch', makeFetchMock({ draftBody: 'auto-filled body' }));

    await importModule();
    await flush();

    expect(textarea().value).toBe('already typed by the user');
  });

  it('leaves the textarea untouched when the draft fetch fails', async () => {
    setPairing();
    setComposeDom();
    vi.stubGlobal('fetch', makeFetchMock({ getDraftOk: false }));

    await importModule();
    await flush();

    expect(textarea().value).toBe('');
  });

  it('does nothing when no compose textarea is present', async () => {
    setPairing();
    document.body.innerHTML = '<button type="submit">Send</button>';
    const fetchMock = makeFetchMock({ draftBody: 'auto-filled body' });
    vi.stubGlobal('fetch', fetchMock);

    await importModule();
    await flush();

    // getDraft was still called (fill() fetches before checking for the
    // textarea), but nothing throws and there is no textarea to assert on.
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('dm-compose send flow', () => {
  it('arms then reports a sent DM once the textarea clears', async () => {
    setPairing();
    setComposeDom();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    await importModule();
    await flush();
    expect(textarea().value).toBe('hello there');

    sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/armed'))).toBe(true);

    // Simulate Reddit clearing the textarea on a successful send.
    textarea().value = '';

    await vi.advanceTimersByTimeAsync(600);
    await flush();

    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sent'))).toBe(true);
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pitchbox:log',
        event: expect.objectContaining({ message: 'activity.reddit-action.dm-sent' }),
      }),
    );
  });

  it('logs a failure event when the backend rejects the sent flip', async () => {
    setPairing();
    setComposeDom();
    const fetchMock = makeFetchMock({ sentOk: false });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    await importModule();
    await flush();

    sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    textarea().value = '';

    await vi.advanceTimersByTimeAsync(600);
    await flush();

    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          level: 'error',
          message: 'activity.reddit-action.fail',
        }),
      }),
    );
  });
});

describe('dm-compose give-up paths (#173)', () => {
  it('logs a distinct reason when the click-poll never observes completion', async () => {
    setPairing();
    setComposeDom();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    await importModule();
    await flush();

    sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    // Never clear the textarea, remove the button, or change the URL - the
    // poll should exhaust its 20s window without detecting completion.
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();

    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sent'))).toBe(false);
    const calls = logCallsFor('activity.reddit-action.send-poll-timeout');
    expect(calls).toHaveLength(1);
    const [msg] = calls[0];
    expect(msg.event.level).toBe('warn');
    expect(msg.event.meta).toEqual({ draftId: 42 });
  });

  it('logs a distinct reason when the send button never appears', async () => {
    setPairing();
    document.body.innerHTML = '<textarea name="text"></textarea>';
    vi.stubGlobal('fetch', makeFetchMock());
    vi.useFakeTimers();

    await importModule();
    await flush();

    await vi.advanceTimersByTimeAsync(15_000);
    await flush();

    const calls = logCallsFor('activity.reddit-action.send-button-not-found');
    expect(calls).toHaveLength(1);
    const [msg] = calls[0];
    expect(msg.event.level).toBe('warn');
    expect(msg.event.meta).toEqual({ draftId: 42 });
  });

  it('does not log a give-up when the send button is found before the timeout', async () => {
    setPairing();
    // No button at first - dm-compose falls back to the MutationObserver path.
    document.body.innerHTML = '<textarea name="text"></textarea>';
    vi.stubGlobal('fetch', makeFetchMock());
    vi.useFakeTimers();

    await importModule();
    await flush();

    // The button shows up shortly after (e.g. the compose form finishes
    // hydrating) - append it before the 15s wire-up window elapses.
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Send';
    document.body.appendChild(btn);

    // MutationObserver callbacks run on a microtask checkpoint, not a timer.
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();

    expect(logCallsFor('activity.reddit-action.send-button-not-found')).toHaveLength(0);
  });
});
