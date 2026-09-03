/**
 * Mounts the in-page panel into a shadow root anchored to a host-page element.
 *
 * This is the first UI Pitchbox renders into a page it does not own. Every
 * other content script (`dm-compose.ts`, `post-comment.ts`, `post-submit.ts`,
 * `chat-token.ts`, `auto-pair.ts`) only reads and writes fields the host page
 * already put there, so there is no in-page precedent in this repo and the
 * rules below come from `docs/design/linkedin-assistant-brief.md` and
 * `docs/design/DECISIONS.md` D10 to D12.
 *
 * Three invariants this module exists to hold:
 *
 * 1. **Isolation both ways.** The panel lives in a shadow root with its own
 *    adopted stylesheet, so LinkedIn's rules cannot reach in and ours cannot
 *    leak out. Nothing is ever appended to the host document except, once, a
 *    font face (see `panel-fonts.ts`).
 * 2. **Exactly one panel, on the anchor that was acted on** (D11). Mounting on
 *    an anchor that already has a panel returns the existing handle instead of
 *    stacking a second one.
 * 3. **It leaves nothing behind.** LinkedIn is a single-page app: anchors are
 *    recycled and routes change without a reload. A panel whose anchor leaves
 *    the document destroys itself, and destroying it removes its host element,
 *    unmounts its component and drops every listener and observer it created.
 */

import { mount, unmount, type Component } from 'svelte';
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
  /** The host-page element the panel belongs to. One panel per anchor (D11). */
  anchor: Element;
  /** Where the host element goes relative to the anchor. */
  position?: 'afterend' | 'beforeend';
  component: Component<Props>;
  props: Props;
  /** Called when the panel destroys itself because its anchor went away. */
  onDetached?: () => void;
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
  const { anchor, position = 'afterend', component, props, onDetached } = options;

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

  anchor.insertAdjacentElement(position, host);

  // An anchored panel that is wider than the thing it is anchored to does not
  // read as belonging to it (D11), and a sibling inserted `afterend` inherits
  // its parent's width, not the anchor's. A smoke render against a fixture
  // whose post was narrower than the page showed the panel spanning the whole
  // viewport. So the width is measured from the anchor and kept in sync.
  //
  // Inline styles rather than a token: this is a measurement of another
  // element, not a design value, so D1 does not apply.
  const syncWidth = () => {
    const { width } = anchor.getBoundingClientRect();
    if (width > 0) host.style.width = `${width}px`;
  };
  syncWidth();

  const view = mount(component, { target: root, props });

  let alive = true;
  let observer: MutationObserver | null = null;
  let resize: ResizeObserver | null = null;

  if (typeof ResizeObserver !== 'undefined') {
    resize = new ResizeObserver(syncWidth);
    resize.observe(anchor);
  }

  const handle: PanelHandle<Props> = {
    update(next) {
      if (!alive) return;
      Object.assign(props, next);
      // Svelte 5 reads props reactively from the object it was handed, so
      // assigning onto it is the update path; there is no `$set` any more.
    },
    destroy() {
      if (!alive) return;
      alive = false;
      observer?.disconnect();
      observer = null;
      resize?.disconnect();
      resize = null;
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
