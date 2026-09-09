import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureAndCropTabRegion } from '../../src/background/capture-post-media.js';
import capturePostMediaSource from '../../src/background/capture-post-media.ts?raw';

/**
 * #569: the background half of "the post's image reaches the model as
 * pixels from the human's own tab" - `chrome.tabs.captureVisibleTab` over
 * the sender's own active tab, cropped and downscaled here, never a fetch of
 * anything. Node has neither `OffscreenCanvas` nor `createImageBitmap`, so
 * the encode pipeline is exercised against fakes; the guard clauses (wrong
 * tab, capture failure) need no canvas at all and run against the real
 * `chrome.tabs` mock alone.
 */

let tabs: Record<number, { id: number; active: boolean; windowId: number }>;
let captureVisibleTab = vi.fn<() => Promise<string>>();

const chromeMock = {
  tabs: {
    get: vi.fn(async (id: number) => {
      const tab = tabs[id];
      if (!tab) throw new Error('no such tab');
      return tab;
    }),
    captureVisibleTab: (..._args: unknown[]) => captureVisibleTab(),
  },
};
const globalWithChrome = globalThis as unknown as { chrome: typeof chrome };
globalWithChrome.chrome = chromeMock as unknown as typeof chrome;

beforeEach(() => {
  tabs = { 1: { id: 1, active: true, windowId: 10 } };
  captureVisibleTab = vi.fn(async () => `data:image/png;base64,${btoa('fake-png-bytes')}`);
});

const BASE_PARAMS = {
  tabId: 1,
  windowId: 10,
  rect: { x: 0, y: 0, width: 400, height: 300 },
  devicePixelRatio: 2,
  maxLongEdgePx: 1024,
};

describe('captureAndCropTabRegion (#569): guard clauses need no canvas at all', () => {
  it('refuses without capturing when the sender tab is no longer the active one', async () => {
    tabs[1].active = false;
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result).toEqual({ ok: false });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('refuses without capturing when the sender tab has moved to a different window', async () => {
    tabs[1].windowId = 99;
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result).toEqual({ ok: false });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('refuses when chrome.tabs.get itself rejects (the tab closed mid-flight)', async () => {
    const result = await captureAndCropTabRegion({ ...BASE_PARAMS, tabId: 404 });
    expect(result).toEqual({ ok: false });
  });

  it('refuses when captureVisibleTab throws - the "tab not visible" case #569 names', async () => {
    captureVisibleTab.mockImplementation(async () => {
      throw new Error('Cannot access contents of the page');
    });
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result).toEqual({ ok: false });
  });

  it('refuses when captureVisibleTab resolves empty', async () => {
    captureVisibleTab.mockImplementation(async () => '');
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result).toEqual({ ok: false });
  });
});

describe('captureAndCropTabRegion (#569): the crop/downscale/encode pipeline', () => {
  let bitmapClose: () => void;
  let convertToBlob: (opts: unknown) => Promise<Blob>;
  let convertToBlobCalls: number;
  let canvasSizes: Array<{ width: number; height: number }>;

  function stubCanvasPipeline(blobBytesPerAttempt: number[]): void {
    convertToBlobCalls = 0;
    convertToBlob = async () => {
      const size =
        blobBytesPerAttempt[Math.min(convertToBlobCalls, blobBytesPerAttempt.length - 1)];
      convertToBlobCalls += 1;
      return new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
    };
    canvasSizes = [];
    bitmapClose = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1200, height: 900, close: bitmapClose })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
          canvasSizes.push({ width, height });
        }
        getContext() {
          return { drawImage: vi.fn() };
        }
        convertToBlob(opts: unknown) {
          return convertToBlob(opts);
        }
      },
    );
  }

  it('returns a data URL under the cap and releases the decoded bitmap', async () => {
    stubCanvasPipeline([100]);
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(bitmapClose).toHaveBeenCalledOnce();
    // rect (400x300 css px) x devicePixelRatio 2 = 800x600 source pixels;
    // under the 1024px cap on the longest edge, so no downscale on attempt 1.
    expect(canvasSizes[0]).toEqual({ width: 800, height: 600 });
  });

  // Hostile fixture (#569 acceptance): a crop that would encode past
  // MAX_IMAGE_DATA_URL_CHARS at every attempted quality/size must never be
  // handed back anyway - the cap wins over "return something".
  it('gives up rather than returning a data URL past the cap, having tried every encode attempt', async () => {
    stubCanvasPipeline([300_000, 300_000, 300_000]);
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result).toEqual({ ok: false });
    expect(convertToBlobCalls).toBe(3);
    // Each attempt after the first uses the same or a smaller canvas.
    expect(canvasSizes[2].width).toBeLessThanOrEqual(canvasSizes[0].width);
  });

  it('succeeds on a later, smaller/lower-quality attempt once the earlier ones are too large', async () => {
    stubCanvasPipeline([300_000, 300_000, 100]);
    const result = await captureAndCropTabRegion(BASE_PARAMS);
    expect(result).toEqual({
      ok: true,
      dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/),
    });
    expect(convertToBlobCalls).toBe(3);
  });

  it('refuses when the crop rect falls entirely outside the decoded bitmap', async () => {
    stubCanvasPipeline([100]);
    const result = await captureAndCropTabRegion({
      ...BASE_PARAMS,
      rect: { x: 5000, y: 5000, width: 400, height: 300 },
    });
    expect(result).toEqual({ ok: false });
  });
});

describe('compliance: never a request toward linkedin.com/licdn.com', () => {
  it('the source text carries no fetch/XHR/sendBeacon call at all', () => {
    expect(capturePostMediaSource).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
  });
});
