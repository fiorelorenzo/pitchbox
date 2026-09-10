// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureObservedImage } from '../../src/content/shared/media-capture.js';
import mediaCaptureSource from '../../src/content/shared/media-capture.ts?raw';

/**
 * #569: the content-script half of "the post's image reaches the model as
 * pixels from the human's own tab". `findPostMedia`'s own selector logic is
 * covered by linkedin-dom.test.ts; this covers the three outcomes
 * `captureObservedImage` can resolve to (see its own doc comment) and the
 * hard cap on what a background-worker response is allowed to hand back.
 */

let sendMessageMock = vi.fn();
let containsMock = vi.fn();
const globalWithChrome = globalThis as unknown as { chrome: typeof chrome };

beforeEach(() => {
  document.body.innerHTML = '';
  sendMessageMock = vi.fn();
  containsMock = vi.fn(async () => true);
  globalWithChrome.chrome = {
    runtime: { sendMessage: sendMessageMock, lastError: undefined },
    permissions: { contains: containsMock },
  } as unknown as typeof chrome;
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 800);
});

function stubRect(el: Element, width: number, height: number, onScreen = true): void {
  const left = onScreen ? 0 : -9999;
  const top = onScreen ? 0 : -9999;
  const rect = {
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
  };
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect });
}

/** Mimics the background worker's own callback-style `sendMessage` reply. */
function respondWith(response: unknown): void {
  sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => cb(response));
}

describe('captureObservedImage (#569)', () => {
  it('returns undefined and never messages the background worker when the post has no substantial media', async () => {
    document.body.innerHTML = '<div id="post"><p>Just text, no image.</p></div>';
    const post = document.getElementById('post')!;
    const image = await captureObservedImage(post, document);
    expect(image).toBeUndefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to alt/kind with no dataUrl, and never messages the background worker, when the media is off-screen', async () => {
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, false);
    const image = await captureObservedImage(post, document);
    expect(image).toEqual({ alt: 'a chart', kind: 'image', partial: false });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to alt/kind with no dataUrl, and never messages the background worker, when the separate image-capture permission is not granted', async () => {
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, true);
    containsMock.mockResolvedValue(false);
    const image = await captureObservedImage(post, document);
    expect(image).toEqual({ alt: 'a chart', kind: 'image', partial: false });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('returns the full shape, dataUrl included, when the background worker captures successfully', async () => {
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, true);
    respondWith({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' });
    const image = await captureObservedImage(post, document);
    expect(image).toEqual({
      alt: 'a chart',
      kind: 'image',
      partial: false,
      dataUrl: 'data:image/jpeg;base64,AAAA',
    });
  });

  it('falls back to alt/kind with no dataUrl when the background worker reports it could not capture', async () => {
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, true);
    respondWith({ ok: false });
    const image = await captureObservedImage(post, document);
    expect(image).toEqual({ alt: 'a chart', kind: 'image', partial: false });
  });

  it('never used chrome.runtime.lastError-throwing sendMessage as a crash - a dead extension context degrades to the alt fallback', async () => {
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, true);
    sendMessageMock.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    const image = await captureObservedImage(post, document);
    expect(image).toEqual({ alt: 'a chart', kind: 'image', partial: false });
  });

  // The real content-script world, which every test above quietly was not:
  // `chrome.permissions` is not part of the API surface a content script
  // gets, so the pre-check threw `Cannot read properties of undefined
  // (reading 'contains')` and the rejection escaped into the assist
  // controller, which left the in-page panel on "Reading the post..."
  // forever on any post carrying an image (measured on the real feed,
  // 2026-09-10). Stubbing `chrome.permissions` is what hid it.
  it('still asks the background worker when chrome.permissions is absent, as it is in a content script', async () => {
    globalWithChrome.chrome = {
      runtime: { sendMessage: sendMessageMock, lastError: undefined },
    } as unknown as typeof chrome;
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, true);
    respondWith({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' });
    const image = await captureObservedImage(post, document);
    expect(sendMessageMock).toHaveBeenCalled();
    expect(image).toEqual({
      alt: 'a chart',
      kind: 'image',
      partial: false,
      dataUrl: 'data:image/jpeg;base64,AAAA',
    });
  });

  // Hostile fixture (#569 acceptance): a background worker (or a crafted
  // response from an untrusted extension context) that hands back a
  // dataUrl past the extension's own cap must never have that cap silently
  // widened - the oversized payload is dropped, not truncated and kept.
  it('drops an oversized dataUrl from the background worker rather than forwarding it past the cap', async () => {
    document.body.innerHTML = '<div id="post"><img id="media" alt="a chart" /></div>';
    const post = document.getElementById('post')!;
    stubRect(document.getElementById('media')!, 400, 300, true);
    const oversized = `data:image/jpeg;base64,${'A'.repeat(300_000)}`;
    respondWith({ ok: true, dataUrl: oversized });
    const image = await captureObservedImage(post, document);
    expect(image).toEqual({ alt: 'a chart', kind: 'image', partial: false });
  });

  it('never fetches or navigates toward linkedin.com/licdn.com, and never touches cookies or storage', () => {
    expect(mediaCaptureSource).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
    expect(mediaCaptureSource).not.toMatch(
      /document\.cookie|localStorage|sessionStorage|chrome\.cookies/,
    );
  });
});
