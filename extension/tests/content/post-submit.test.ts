// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { armedMock, sentMock } = vi.hoisted(() => ({
  armedMock: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
  sentMock: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
}));

vi.mock('../../src/lib/api.js', () => ({
  api: { armed: armedMock, sent: sentMock },
}));

(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
  },
};

function setUrl(url: string) {
  window.history.pushState({}, '', url);
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function addSubmitButton(label = 'Post'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.textContent = label;
  document.body.appendChild(btn);
  return btn;
}

function click(btn: HTMLButtonElement) {
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function logCalls(): Array<{ type: string; event: Record<string, unknown> }> {
  return (
    (globalThis as any).chrome.runtime.sendMessage as ReturnType<typeof vi.fn>
  ).mock.calls.map((c: unknown[]) => c[0] as { type: string; event: Record<string, unknown> });
}

function findLog(message: string) {
  return logCalls().find((c) => c.event?.message === message);
}

beforeEach(() => {
  vi.resetModules();
  armedMock.mockClear();
  sentMock.mockClear();
  (globalThis as any).chrome.runtime.sendMessage.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

async function importModule() {
  return await import('../../src/content/post-submit.js');
}

describe('extractT3 (#205)', () => {
  it('extracts the t3 id from a canonical /comments/<id>/<slug>/ redirect', async () => {
    setUrl('http://localhost:3000/r/test/submit');
    const { extractT3 } = await importModule();
    expect(extractT3('https://www.reddit.com/r/test/comments/abc123/my-title/')).toBe('t3_abc123');
  });

  it('extracts the t3 id with no trailing slug', async () => {
    setUrl('http://localhost:3000/r/test/submit');
    const { extractT3 } = await importModule();
    expect(extractT3('https://www.reddit.com/r/test/comments/abc123')).toBe('t3_abc123');
  });

  it('is case-insensitive on the id', async () => {
    setUrl('http://localhost:3000/r/test/submit');
    const { extractT3 } = await importModule();
    expect(extractT3('https://old.reddit.com/r/test/comments/ABC123/')).toBe('t3_ABC123');
  });

  it('returns null for a non-comments path', async () => {
    setUrl('http://localhost:3000/r/test/submit');
    const { extractT3 } = await importModule();
    expect(extractT3('https://www.reddit.com/r/test/submit')).toBeNull();
  });

  it('returns null for an unparseable URL', async () => {
    setUrl('http://localhost:3000/r/test/submit');
    const { extractT3 } = await importModule();
    expect(extractT3('not a url')).toBeNull();
  });
});

describe('post-submit content script - live /submit page', () => {
  it('arms when the submit button is clicked (#204)', async () => {
    setUrl('http://localhost:3000/r/test/submit?pitchbox_draft=42');
    const btn = addSubmitButton();
    await importModule();
    await flush();

    click(btn);
    await flush();

    expect(armedMock).toHaveBeenCalledWith(42, undefined);
  });

  it('detects an SPA-style redirect via URL polling and calls api.sent', async () => {
    vi.useFakeTimers();
    setUrl('http://localhost:3000/r/test/submit?pitchbox_draft=42');
    const btn = addSubmitButton();
    await importModule();
    await flush();

    click(btn);
    await flush();

    setUrl('http://localhost:3000/r/test/comments/abc123/my-title/');
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(sentMock).toHaveBeenCalledWith(
      42,
      undefined,
      undefined,
      't3_abc123',
      undefined,
      undefined,
    );
    expect(findLog('activity.reddit-action.submit-sent')).toBeTruthy();
  });

  it('gives up and logs a warn when the URL changes away from /submit without a t3 (#173)', async () => {
    vi.useFakeTimers();
    setUrl('http://localhost:3000/r/test/submit?pitchbox_draft=42');
    await importModule();
    await flush();

    setUrl('http://localhost:3000/');
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(sentMock).not.toHaveBeenCalled();
    expect(findLog('activity.reddit-action.submit-no-t3')).toBeTruthy();
  });

  it('gives up and logs a warn when the poll times out without ever seeing a t3 (#173)', async () => {
    vi.useFakeTimers();
    setUrl('http://localhost:3000/r/test/submit?pitchbox_draft=42');
    const btn = addSubmitButton();
    await importModule();
    await flush();
    click(btn);
    await flush();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(sentMock).not.toHaveBeenCalled();
    expect(findLog('activity.reddit-action.submit-poll-timeout')).toBeTruthy();
  });

  it('logs a warn when the submit button is never found (#173)', async () => {
    vi.useFakeTimers();
    setUrl('http://localhost:3000/r/test/submit?pitchbox_draft=42');
    await importModule();
    await flush();

    await vi.advanceTimersByTimeAsync(15_000);
    await flush();

    expect(armedMock).not.toHaveBeenCalled();
    expect(findLog('activity.reddit-action.submit-button-not-found')).toBeTruthy();
  });
});

describe('post-submit content script - hard navigation (old.reddit.com)', () => {
  it('does nothing on a plain /comments/ page view (no pitchbox_draft): re-attribution is intentionally not attempted', async () => {
    setUrl('http://localhost:3000/r/test/comments/abc123/my-title/');

    await importModule();
    await flush();

    expect(sentMock).not.toHaveBeenCalled();
    expect(armedMock).not.toHaveBeenCalled();
  });
});
