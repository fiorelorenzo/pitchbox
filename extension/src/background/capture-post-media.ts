/**
 * Crops and downscales a region of the sender tab's own visible viewport
 * (#569) - `chrome.tabs.captureVisibleTab` is the only capability this
 * touches: a browser API over the tab the human is already looking at, not
 * a request to LinkedIn or anywhere else. The crop this returns is the only
 * thing that ever leaves this module; the full-viewport screenshot itself
 * is decoded, cropped and discarded here.
 *
 * Runs in the background service worker rather than the content script
 * because `captureVisibleTab` is only callable from there, and because
 * `OffscreenCanvas`/`createImageBitmap` need no DOM the content script's own
 * page provides anyway - the decode-crop-encode pipeline below only needs
 * globals a service worker already has.
 */

export type CaptureRegionParams = {
  tabId: number;
  windowId: number;
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  maxLongEdgePx: number;
};

export type CaptureRegionResult = { ok: true; dataUrl: string } | { ok: false };

/** Mirrors shared/src/assist/suggest-prompt.ts's `MAX_IMAGE_DATA_URL_CHARS`
 * by hand - see extension/src/content/shared/media-capture.ts's own note on
 * why. Checked again here, not just by the caller, because this is where
 * the encoded bytes actually exist. */
const MAX_IMAGE_DATA_URL_CHARS = 280_000;

/** Re-encodes at progressively smaller size/quality until the result fits
 * under the cap, or gives up. The first attempt is already modest - a
 * vision model does not need a retina asset - so this only matters for the
 * rare crop that is unusually large or busy (a screenshot of dense text,
 * say) and would not otherwise compress well. */
const ENCODE_ATTEMPTS: ReadonlyArray<{ longEdgeScale: number; quality: number }> = [
  { longEdgeScale: 1, quality: 0.75 },
  { longEdgeScale: 1, quality: 0.5 },
  { longEdgeScale: 0.6, quality: 0.5 },
];

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `String.fromCharCode(...bytes)` in one call blows the argument-count
 * limit on a large screenshot, so this walks the buffer in fixed chunks -
 * the same reason `bytesToBase64` exists at all rather than a one-liner. */
function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Captures whatever is visible in `params.windowId` right now, crops it to
 * `params.rect` (already viewport-relative css px, scaled here by
 * `devicePixelRatio` into the screenshot's own physical pixels) and
 * downscales/re-encodes until the result fits `MAX_IMAGE_DATA_URL_CHARS`.
 *
 * Refuses rather than guesses whenever the capture could silently be of the
 * wrong tab: `chrome.tabs.captureVisibleTab(windowId, ...)` captures
 * whichever tab is currently active in that window, so a sender tab that
 * has stopped being the active one (the human switched tabs between the
 * click and this call resolving) would otherwise return a screenshot of
 * something else entirely - the "tab not visible" fallback #569's issue
 * names, made concrete.
 */
export async function captureAndCropTabRegion(
  params: CaptureRegionParams,
): Promise<CaptureRegionResult> {
  const tab = await chrome.tabs.get(params.tabId).catch(() => null);
  if (!tab || !tab.active || tab.windowId !== params.windowId) return { ok: false };

  let screenshotDataUrl: string;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(params.windowId, { format: 'png' });
  } catch {
    return { ok: false };
  }
  if (!screenshotDataUrl) return { ok: false };

  let bitmap: ImageBitmap;
  try {
    const comma = screenshotDataUrl.indexOf(',');
    const bytes = base64ToBytes(screenshotDataUrl.slice(comma + 1));
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  } catch {
    return { ok: false };
  }

  try {
    const dpr = params.devicePixelRatio || 1;
    const sx = Math.max(0, Math.round(params.rect.x * dpr));
    const sy = Math.max(0, Math.round(params.rect.y * dpr));
    const sw = Math.min(bitmap.width - sx, Math.round(params.rect.width * dpr));
    const sh = Math.min(bitmap.height - sy, Math.round(params.rect.height * dpr));
    if (sw <= 0 || sh <= 0) return { ok: false };

    for (const attempt of ENCODE_ATTEMPTS) {
      const longEdge = params.maxLongEdgePx * attempt.longEdgeScale;
      const scale = Math.min(1, longEdge / Math.max(sw, sh));
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));

      const canvas = new OffscreenCanvas(dw, dh);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: attempt.quality });
      const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) return { ok: true, dataUrl };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  } finally {
    bitmap.close();
  }
}
