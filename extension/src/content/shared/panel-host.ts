/**
 * Mounts the in-page panel into a shadow root, floating over the page rather
 * than living inside it.
 *
 * This is the first UI Pitchbox renders into a page it does not own. Every
 * other content script (`dm-compose.ts`, `post-comment.ts`, `post-submit.ts`,
 * `chat-token.ts`, `auto-pair.ts`) only reads and writes fields the host page
 * already put there, so there is no in-page precedent in this repo and the
 * rules below come from `docs/design/linkedin-assistant-brief.md` and
 * `docs/design/DECISIONS.md` D10, D12 and D13.
 *
 * Four invariants this module exists to hold:
 *
 * 1. **Isolation both ways.** The panel lives in a shadow root with its own
 *    adopted stylesheet, so LinkedIn's rules cannot reach in and ours cannot
 *    leak out. Nothing is ever appended to the host document except, once, a
 *    font face (see `panel-fonts.ts`), and the host element itself.
 * 2. **Exactly one panel, on the anchor that was acted on.** Mounting on an
 *    anchor that already has a panel returns the existing handle instead of
 *    stacking a second one.
 * 3. **Its own size and position, never the anchor's** (D13). The panel used
 *    to be a document sibling sized from the anchor's own width, which on a
 *    real post's ~260px comment form made it unreadable. It now floats in
 *    viewport coordinates, positioned against the anchor's rect and kept
 *    there while the page scrolls or resizes, and closes itself on `Escape`
 *    or an outside click since a floating surface needs that in a way an
 *    inline one did not.
 * 4. **It leaves nothing behind.** LinkedIn is a single-page app: anchors are
 *    recycled and routes change without a reload. A panel whose anchor leaves
 *    the document destroys itself, and destroying it removes its host element,
 *    unmounts its component and drops every listener and observer it created.
 */

import { mount, unmount, type Component } from 'svelte';
import { reactiveProps } from './panel-props.svelte.js';
// `?inline` hands back the compiled stylesheet as a string instead of having
// Vite inject a <style> into the host document, which is the whole point: the
// text goes into the shadow root and linkedin.com's <head> is never touched.
import panelCss from '../panel.css?inline';
import { ensurePanelFont } from './panel-fonts.js';

/** Marks a host element so a second mount on the same anchor is detectable. */
const HOST_TAG = 'pitchbox-panel-host';

export type PanelHandle<Props extends Record<string, unknown>> = {
  /** Replace the component's props. No-op once destroyed. */
  update(props: Partial<Props>): void;
  /** Unmount, remove the host element, drop every listener. Idempotent. */
  destroy(): void;
  /** False once `destroy` has run, or once the anchor left the document. */
  readonly alive: boolean;
  /** The shadow root, for tests and for focus management. */
  readonly shadow: ShadowRoot;
};

export type MountOptions<Props extends Record<string, unknown>> = {
  /** The host-page element the panel belongs to. One panel per anchor. */
  anchor: Element;
  component: Component<Props>;
  props: Props;
  /** Called when the panel destroys itself because its anchor went away. */
  onDetached?: () => void;
  /**
   * Called on `Escape` or a pointer-down outside the panel. A floating
   * surface needs a way to dismiss itself that an inline sibling never did;
   * the caller decides what dismissal means (usually `handle.destroy()`).
   * Omit it and the panel only ever closes through its own controls.
   */
  onDismiss?: () => void;
};

const mounted = new WeakMap<Element, PanelHandle<Record<string, never>>>();

let sheet: CSSStyleSheet | null = null;

/**
 * The panel's stylesheet, built once and adopted by every shadow root. A
 * constructed sheet is shared by reference, so N panels cost one parse.
 *
 * `adoptedStyleSheets` and the `CSSStyleSheet` constructor are the reason the
 * panel needs no `<style>` element at all. Where the constructor is missing
 * (jsdom without the flag, an old engine) the caller falls back to a `<style>`
 * inside the shadow root, which is still scoped to it.
 */
function panelStyleSheet(): CSSStyleSheet | null {
  if (sheet) return sheet;
  if (typeof CSSStyleSheet === 'undefined') return null;
  try {
    const s = new CSSStyleSheet();
    // `replaceSync` rejects @import, which is why panel.css is imported
    // through Vite (`?inline`) already flattened rather than at runtime.
    s.replaceSync(panelCss);
    sheet = s;
    return s;
  } catch {
    return null;
  }
}

function applyStyles(shadow: ShadowRoot): void {
  const constructed = panelStyleSheet();
  if (constructed && 'adoptedStyleSheets' in shadow) {
    shadow.adoptedStyleSheets = [constructed];
    return;
  }
  const style = document.createElement('style');
  style.textContent = panelCss;
  shadow.append(style);
}

/** Gap kept between the panel and both the anchor and the viewport edge. */
const OVERLAY_MARGIN = 12;

/**
 * The floating card's own width (D13): never the anchor's, which on a
 * post-detail page's ~260px comment form is what made the panel unreadable
 * in the first place. Mirrored in panel.css's `:host { width }` rule; kept
 * here too because the placement math below needs it before layout runs.
 *
 * 520px, not the 440px D13 shipped (D16, 2026-09-08): Inter at the draft's
 * 16px lands at about 66 characters per line here, which is the middle of
 * the classical band, and 520 is the narrowest width that gets there. 440
 * was fine for 14px body text and was carrying 15px over 13px instead, so
 * it read as cramped.
 */
const OVERLAY_WIDTH = 520;

/**
 * The panel's shortest useful size, and the assumed height before it has
 * ever rendered: at that point `computeOverlayPlacement` has nothing real
 * to measure yet, and assuming the shortest size means the first paint is
 * never shifted or flipped on a guess a `ResizeObserver` corrects a frame
 * later anyway.
 */
const OVERLAY_MIN_HEIGHT = 160;

/** Mirrors panel.css's `:host { max-height: 60vh }` default. */
const OVERLAY_MAX_HEIGHT_RATIO = 0.6;

/** A structural subset of `DOMRect`, so placement can be tested without one. */
type AnchorRect = { top: number; left: number; right: number; bottom: number };

type OverlayPlacement = {
  left: number;
  /** Viewport pixels from the top; `null` when `bottom` is used instead. */
  top: number | null;
  /** Viewport pixels from the bottom; `null` when `top` is used instead. */
  bottom: number | null;
  maxHeight: number;
};

/**
 * Where the floating panel goes for a given anchor rect, viewport size and
 * the panel's own current rendered height.
 *
 * Pure on purpose: jsdom's layout engine returns zeroed-out rects for
 * everything, which makes the placement rules unprovable through a real
 * mount. Exported so a test can drive the rule directly instead of
 * asserting on pixels jsdom never computed.
 *
 * `panelHeight` matters because the panel's height is not fixed: it starts
 * at a skeleton's height and grows as a suggestion streams in (#387). A
 * placement computed once from the anchor alone stays valid only for the
 * height it was computed for - measured on a real page, a panel placed at
 * `top: anchor.top` for a 116px skeleton grew to 160px as the draft arrived
 * and ran 66px past the bottom of the viewport, because nothing recomputed
 * `top` for the new height. This function is deliberately re-run by a
 * `ResizeObserver` on the host every time that height changes, not just on
 * anchor move or viewport resize.
 *
 * The anchor's right side is preferred (D13), so the panel reads as
 * belonging to the thing that was clicked without covering it; there it is
 * shifted up rather than left to run past the bottom of the viewport, which
 * is always safe because floating beside the anchor never requires vertical
 * alignment with it. When there is not enough width for that, it stacks
 * under the anchor instead, aligned to its left edge and clamped inside the
 * viewport horizontally. Shifting *that* up to fit would risk pulling it
 * into the anchor itself, so when the current height does not fit below,
 * it stacks above instead: anchored to the viewport's bottom edge from the
 * anchor's own top edge, which needs no shift because the whole rest of the
 * page above the anchor is normally there to grow into.
 */
export function computeOverlayPlacement(
  anchor: AnchorRect,
  viewportWidth: number,
  viewportHeight: number,
  panelHeight: number,
): OverlayPlacement {
  const width = Math.min(OVERLAY_WIDTH, viewportWidth - OVERLAY_MARGIN * 2);
  const spaceRight = viewportWidth - anchor.right - OVERLAY_MARGIN;
  const height = panelHeight > 0 ? panelHeight : OVERLAY_MIN_HEIGHT;

  let left: number;
  let top: number | null;
  let bottom: number | null;

  if (spaceRight >= width) {
    left = anchor.right + OVERLAY_MARGIN;
    top = Math.max(Math.min(anchor.top, viewportHeight - OVERLAY_MARGIN - height), OVERLAY_MARGIN);
    bottom = null;
  } else {
    left = anchor.left;
    const spaceBelow = viewportHeight - anchor.bottom - OVERLAY_MARGIN;
    if (spaceBelow >= height) {
      top = anchor.bottom + OVERLAY_MARGIN;
      bottom = null;
    } else {
      top = null;
      bottom = viewportHeight - anchor.top + OVERLAY_MARGIN;
    }
  }

  // Clamped inside the viewport rather than left to run off it: `maxLeft`
  // guards the inverted-range case (a viewport narrower than the panel's own
  // minimum) by never dropping below `minLeft`.
  const minLeft = OVERLAY_MARGIN;
  const maxLeft = Math.max(viewportWidth - width - OVERLAY_MARGIN, minLeft);
  left = Math.min(Math.max(left, minLeft), maxLeft);

  // The hard ceiling `panel.css`'s `max-height` is set to. No floor here on
  // purpose (there used to be one, at `OVERLAY_MIN_HEIGHT` - it is what
  // caused the overflow above): `top`/`bottom` above are already chosen so
  // the *current* height fits, so the ceiling only needs to stop the panel
  // growing past that same room before the next `ResizeObserver` tick can
  // react to it.
  const available =
    top !== null ? viewportHeight - top - OVERLAY_MARGIN : anchor.top - OVERLAY_MARGIN * 2;
  const maxHeight = Math.min(viewportHeight * OVERLAY_MAX_HEIGHT_RATIO, available);

  return { left, top, bottom, maxHeight };
}

/** Applies `computeOverlayPlacement` to `host`'s inline style. */
function positionOverlay(host: HTMLElement, anchor: Element): void {
  const placement = computeOverlayPlacement(
    anchor.getBoundingClientRect(),
    window.innerWidth,
    window.innerHeight,
    host.getBoundingClientRect().height,
  );
  host.style.left = `${placement.left}px`;
  if (placement.top !== null) {
    host.style.top = `${placement.top}px`;
    host.style.bottom = 'auto';
  } else {
    host.style.top = 'auto';
    host.style.bottom = `${placement.bottom}px`;
  }
  host.style.maxHeight = `${placement.maxHeight}px`;
}

/**
 * Mount the panel on `anchor`, or return the panel already mounted there.
 *
 * Never throws for a reason that is only cosmetic: a font that fails to
 * register leaves the panel in its fallback stack rather than refusing to
 * appear.
 */
export function mountPanel<Props extends Record<string, unknown>>(
  options: MountOptions<Props>,
): PanelHandle<Props> {
  const { anchor, component, props, onDetached, onDismiss } = options;

  const existing = mounted.get(anchor) as PanelHandle<Props> | undefined;
  if (existing?.alive) return existing;

  const host = document.createElement(HOST_TAG);
  // A custom-element name with no definition behind it is an unknown element:
  // inert, no default styling, and it cannot collide with a LinkedIn selector
  // the way a `div` with a class can.
  host.setAttribute('data-pitchbox', 'panel');
  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow);

  // The panel root carries `.dark`, which selects the dark token values and
  // makes Tailwind's `dark:` variant work inside the shadow tree. The panel is
  // always dark regardless of LinkedIn's theme: it reads as a Pitchbox surface,
  // never as part of LinkedIn (D10).
  const root = document.createElement('div');
  root.className = 'pitchbox-panel dark';
  shadow.append(root);

  // D13: appended to the document itself, not next to the anchor. The panel
  // used to be a sibling sized from the anchor's own width, which inherited
  // whatever column the anchor happened to sit in (~260px on a post-detail
  // page's comment form); a true overlay needs neither that width nor that
  // position in the document. `position` is set inline as well as in
  // panel.css's `:host` rule: everything else about placement already has to
  // be inline (the coordinates are per-mount, computed values), so the host
  // is never left un-positioned by a stylesheet that failed to adopt.
  host.style.position = 'fixed';
  document.body.append(host);

  // Reactive, not the caller's plain object: `mount()` does not make props
  // reactive, so assigning onto a plain object re-renders nothing. The panel's
  // entire state machine arrives through `update()` below, so this is what
  // makes the panel able to show anything other than its first frame (#369).
  const live = reactiveProps({ ...props });
  const view = mount(component, { target: root, props: live });

  // Mounted before the first `reposition()` call, not after: placement reads
  // the panel's own rendered height (`computeOverlayPlacement`'s `panelHeight`),
  // and a host with no content yet would measure zero.
  const reposition = () => positionOverlay(host, anchor);
  reposition();

  let alive = true;
  let observer: MutationObserver | null = null;
  let anchorResize: ResizeObserver | null = null;
  let panelResize: ResizeObserver | null = null;

  if (typeof ResizeObserver !== 'undefined') {
    // The anchor moving is not the only way the panel drifts out of place:
    // its own box can change size (a composer growing as the human types)
    // without the page ever scrolling or the window ever resizing.
    anchorResize = new ResizeObserver(reposition);
    anchorResize.observe(anchor);

    // Nor is the anchor the only thing that moves: the panel's own height
    // grows as a suggestion streams in (#387), and a placement computed for
    // a shorter height does not shrink to fit a taller one on its own -
    // measured on a real page, a panel placed for a 116px skeleton grew to
    // 160px and ran 66px past the bottom of the viewport because nothing
    // ever recomputed `top` for the new height.
    panelResize = new ResizeObserver(reposition);
    panelResize.observe(host);
  }

  // `scroll` does not bubble, so catching every scroll on the page - the feed
  // itself, a nested modal, one of LinkedIn's own scroll containers - needs
  // the capture phase on `window` rather than a bubble-phase listener
  // anywhere more specific. `resize` covers the window itself changing size.
  // Never a timer: both fire only when the anchor could actually have moved.
  window.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', reposition);

  // A floating surface needs a way to dismiss itself that an inline sibling
  // never did. `composedPath()` rather than `event.target`: a listener on
  // `document` sees `target` retargeted to the host element for anything
  // that happened inside the (open) shadow root, which would make every
  // click on the panel read as "outside" through simple `contains()`. The
  // composed path still lists the actual node the pointer landed on, so a
  // click on the textarea never closes the panel it is inside.
  const onPointerDown = (event: PointerEvent) => {
    if (event.composedPath().includes(host)) return;
    onDismiss?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    onDismiss?.();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);

  const handle: PanelHandle<Props> = {
    update(next) {
      if (!alive) return;
      Object.assign(live, next);
    },
    destroy() {
      if (!alive) return;
      alive = false;
      observer?.disconnect();
      observer = null;
      anchorResize?.disconnect();
      anchorResize = null;
      panelResize?.disconnect();
      panelResize = null;
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      unmount(view);
      host.remove();
      mounted.delete(anchor);
    },
    get alive() {
      return alive;
    },
    get shadow() {
      return shadow;
    },
  };

  // LinkedIn recycles feed nodes and routes without reloading, so an anchor can
  // leave the document at any moment. Watching for that is what keeps a
  // navigation from leaving an orphaned panel behind, or stacking a second one
  // when the same post scrolls back in.
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (anchor.isConnected) return;
      handle.destroy();
      onDetached?.();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  mounted.set(anchor, handle as unknown as PanelHandle<Record<string, never>>);

  // Fire and forget: the panel is already on screen, and the font arriving a
  // beat later is a repaint, not a mount.
  void ensurePanelFont().catch((err: unknown) => {
    // Cosmetic: panel.css's fallback stack covers it. Logged rather than
    // swallowed so a font that never arrives is diagnosable instead of
    // invisible.
    console.warn('[pitchbox] panel font unavailable', err);
  });

  return handle;
}

/** The panel mounted on `anchor`, if one is still alive there. */
export function panelFor(anchor: Element): PanelHandle<Record<string, never>> | null {
  const handle = mounted.get(anchor);
  return handle?.alive ? handle : null;
}

/** Test seam: forget the constructed stylesheet. */
export function resetPanelStylesForTests(): void {
  sheet = null;
}
