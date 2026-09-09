import { findPostMedia, type PostMediaKind } from './linkedin-dom.js';
import { hasImageCapturePermission } from '../../lib/permissions.js';

/**
 * Captures a post's attached media as pixels from the human's own rendered
 * tab (#569) - the content script only ever finds the element and asks the
 * background worker to capture and crop it; the actual pixels never touch
 * anything but `chrome.tabs.captureVisibleTab`, a browser capability over
 * the visible tab. No network call, no synthetic interaction, no cookie
 * read - see docs/design/in-page-agent.md's "capture the rendered tab,
 * never fetch licdn" rule.
 */

/** Mirrors shared/src/assist/suggest-prompt.ts's `ObservedImage` by hand -
 * see extension/src/lib/api.ts's own note on why the extension carries no
 * dependency on @pitchbox/shared. */
export type CapturedImage = {
  dataUrl?: string;
  alt?: string;
  kind: PostMediaKind;
  partial?: boolean;
};

/** Mirrors shared/src/assist/suggest-prompt.ts's `MAX_IMAGE_DATA_URL_CHARS`
 * by hand - the server's own zod schema enforces the same number again
 * rather than trusting this clamp (AGENTS.md: a switch is enforced where
 * the effect happens, not only where it is read). */
const MAX_IMAGE_DATA_URL_CHARS = 280_000;

/** A vision model does not need a retina asset (#569's own issue text) - the
 * background worker downscales to this on the longest edge, in css px
 * before device-pixel scaling. */
const MAX_CAPTURE_LONG_EDGE_PX = 1024;

/** Below this much overlap with the viewport (css px, either axis), the
 * media counts as scrolled off-screen rather than barely visible - a crop
 * of a sliver describes nothing a vision model could use. */
const MIN_VIEWPORT_OVERLAP_PX = 40;

type CaptureMessageResponse = { ok: true; dataUrl: string } | { ok: false };

/** The rect `chrome.tabs.captureVisibleTab`'s image actually covers -
 * `getBoundingClientRect()`'s coordinates are already viewport-relative, so
 * this only clips to what is currently on screen. `null` when what remains
 * is too small to be worth capturing at all. */
function viewportOverlap(
  rect: DOMRect,
): { x: number; y: number; width: number; height: number } | null {
  const x0 = Math.max(0, rect.left);
  const y0 = Math.max(0, rect.top);
  const x1 = Math.min(window.innerWidth, rect.right);
  const y1 = Math.min(window.innerHeight, rect.bottom);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < MIN_VIEWPORT_OVERLAP_PX || height < MIN_VIEWPORT_OVERLAP_PX) return null;
  return { x: x0, y: y0, width, height };
}

/**
 * Captures `post`'s attached media, when it has one worth reading pixels
 * from. Three outcomes, honestly distinct (see
 * shared/src/assist/suggest-prompt.ts's `ObservedImage` doc comment for what
 * each means to whoever reads the request on the other end):
 *
 * - no substantial media at all: `undefined` - the request carries no
 *   `image` field, so no vision call is ever spent on it.
 * - media exists but nothing reached us (off-screen, the background
 *   worker's own capture failed, permission not granted, or the result
 *   would not fit under the cap even downscaled): `{ alt, kind, partial }`
 *   with no `dataUrl` - LinkedIn's own alt text when it rendered one.
 * - media exists and the capture succeeded: the full shape, `dataUrl`
 *   included.
 */
export async function captureObservedImage(
  post: Element,
  root: ParentNode = document,
): Promise<CapturedImage | undefined> {
  const media = findPostMedia(post, root);
  if (!media) return undefined;

  const fallback: CapturedImage = { alt: media.alt, kind: media.kind, partial: media.partial };
  // #569: image capture is its own opt-in (Main's call, 2026-09-09) - see
  // ImageCaptureAccessRow.svelte's own doc comment for why it is a separate
  // grant from the base LinkedIn permission. Checked before even computing
  // whether the media is on screen, so a device that never turned this on
  // never pays for the viewport math either.
  if (!(await hasImageCapturePermission())) return fallback;
  const rect = viewportOverlap(media.element.getBoundingClientRect());
  if (!rect) return fallback;

  const response = await new Promise<CaptureMessageResponse>((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'pitchbox:capture-post-media',
          rect,
          devicePixelRatio: window.devicePixelRatio || 1,
          maxLongEdgePx: MAX_CAPTURE_LONG_EDGE_PX,
        },
        (res: CaptureMessageResponse | undefined) => {
          resolve(chrome.runtime.lastError || !res ? { ok: false } : res);
        },
      );
    } catch {
      resolve({ ok: false });
    }
  });

  if (!response.ok || response.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) return fallback;
  return { ...fallback, dataUrl: response.dataUrl };
}
