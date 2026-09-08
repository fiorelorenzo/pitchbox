// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Component } from 'svelte';
import { mountPanel, computeOverlayPlacement } from '../../src/content/shared/panel-host.js';

/**
 * Overlay placement and dismissal for the in-page panel host (D13, #386,
 * #387).
 *
 * `computeOverlayPlacement` is tested directly rather than through a mounted
 * host: jsdom's layout engine returns a zeroed-out rect for every element
 * unless `getBoundingClientRect` is stubbed, which would make any assertion
 * on the *numbers* `panel-host.ts` derives from a real anchor either
 * meaningless (stubbed to whatever the test wants) or untestable (unstubbed,
 * always zero). The placement rule itself has real branches - right, then
 * below, then above, each aware of the panel's own current height - and
 * those are what this file proves, both in the pure function and, for the
 * DOM wiring around it, against a mounted host.
 */
vi.mock('../../src/content/panel.css?inline', () => ({
  default: ':host{display:block}.pitchbox-panel{color:var(--foreground)}',
}));
vi.mock('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url', () => ({
  default: 'assets/inter.woff2',
}));

/**
 * A stand-in for the panel's Svelte component, matching the pattern in
 * `panel-host.test.ts`: a hand-written function driven through the real
 * `mount`/`unmount` pair, free of the Svelte compiler the root vitest config
 * does not load.
 */
function probeComponent(anchor: unknown, props: { label: string }): Record<string, never> {
  const node = anchor as Node | null;
  const target = node?.parentNode as HTMLElement | null;
  if (target) {
    const el = document.createElement('p');
    el.className = 'probe';
    el.textContent = props.label;
    target.append(el);
  }
  return {};
}
const Probe = probeComponent as unknown as Component<{ label: string }>;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // @ts-expect-error deliberately removing an optional global
  delete globalThis.FontFace;
});

// See panel-host.test.ts for why the DOM cleanup matters. `unstubAllGlobals`
// matters here specifically: one test below stubs a fake `ResizeObserver`
// onto the global, and `restoreAllMocks` in `beforeEach` does not undo
// `stubGlobal` - without this, that fake would leak into every test after it.
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function anchorEl(): HTMLElement {
  const el = document.createElement('article');
  document.body.append(el);
  return el;
}

/** Stubs `anchor`'s rect and the viewport size `computeOverlayPlacement` reads. */
function stubViewport(
  anchor: Element,
  rect: { top: number; left: number; right: number; bottom: number },
  viewport: { width: number; height: number },
): void {
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  });
  vi.stubGlobal('innerWidth', viewport.width);
  vi.stubGlobal('innerHeight', viewport.height);
}

/**
 * jsdom (this project's version) has no `ResizeObserver` at all, so
 * `mountPanel`'s `typeof ResizeObserver !== 'undefined'` guard is false in
 * every other test in this file - the DOM tests below drive `reposition()`
 * through `scroll`/`resize` instead, which is real coverage for those paths
 * but cannot stand in for the panel's own size changing without anything
 * else moving. This installs a fake that records one trigger function per
 * observed element, so exactly the test that needs it can fire that path
 * deliberately.
 */
function installFakeResizeObserver(): { forTarget(el: Element): void } {
  const byTarget = new Map<Element, () => void>();
  class FakeResizeObserver {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element): void {
      byTarget.set(el, () =>
        this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver),
      );
    }
    unobserve(el: Element): void {
      byTarget.delete(el);
    }
    disconnect(): void {
      byTarget.clear();
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return {
    forTarget(el: Element) {
      byTarget.get(el)?.();
    },
  };
}

describe('computeOverlayPlacement', () => {
  it('prefers the anchor\u2019s right side when there is room', () => {
    const placement = computeOverlayPlacement(
      { top: 100, left: 300, right: 560, bottom: 140 },
      1200,
      800,
      160,
    );
    expect(placement.top).toBe(100);
    expect(placement.bottom).toBeNull();
    expect(placement.left).toBe(560 + 12);
  });

  it('flips to below the anchor, pulled left of a naive alignment, when the anchor is near the right edge', () => {
    // 1180 of a 1200-wide viewport: 8px to the right, nowhere near the
    // panel's ~520px width.
    const anchor = { top: 100, left: 1000, right: 1180, bottom: 140 };
    const placement = computeOverlayPlacement(anchor, 1200, 800, 160);

    expect(placement.top).toBe(anchor.bottom + 12);
    expect(placement.bottom).toBeNull();
    // Aligned to the anchor's left edge in principle, but clamped inside the
    // viewport - a 520px-wide panel at left:1000 in a 1200-wide viewport
    // would run 252px past the right edge.
    expect(placement.left).toBeLessThan(anchor.left);
    expect(placement.left + 520).toBeLessThanOrEqual(1200);
  });

  it('flips above the anchor when there is not enough room to the side or below', () => {
    // Same right-edge squeeze as above, plus the anchor sits 8px above the
    // bottom of the viewport too.
    const anchor = { top: 740, left: 1000, right: 1180, bottom: 780 };
    const placement = computeOverlayPlacement(anchor, 1200, 800, 160);

    expect(placement.top).toBeNull();
    expect(placement.bottom).toBe(800 - anchor.top + 12);
  });

  it('never places the panel outside the viewport, even when the viewport is narrower than the panel', () => {
    const anchor = { top: 50, left: -40, right: 20, bottom: 90 };
    const placement = computeOverlayPlacement(anchor, 300, 800, 160);

    expect(placement.left).toBeGreaterThanOrEqual(12);
    expect(placement.left).toBeLessThanOrEqual(300 - 12);
  });

  it('narrows the width on a narrow window, mirroring panel.css\u2019s min(520px, 100vw - 24px)', () => {
    // Far enough right that it never fits beside the anchor in either
    // viewport, so `left` always clamps to `viewportWidth - width - margin`
    // and reads back the width the placement actually used.
    const anchor = { top: 0, left: 5000, right: 5050, bottom: 40 };

    const wide = computeOverlayPlacement(anchor, 1200, 800, 160);
    // width is the unclamped 520px default: left = 1200 - 520 - 12.
    expect(wide.left).toBe(1200 - 520 - 12);

    const narrow = computeOverlayPlacement(anchor, 380, 800, 160);
    // width is min(520, 380 - 24) = 356, which puts the panel flush against
    // the viewport's own margin: left = 380 - 356 - 12 = 12.
    expect(narrow.left).toBe(12);
  });

  it('picks below at a short height but flips above once the current height would not fit below (#387)', () => {
    // Not enough room to the right (900 of a 1000-wide viewport is 88px,
    // short of the panel's ~520px), and 800 - 640 - 12 = 148px below - real
    // room for a short panel, not for a tall one.
    const anchor = { top: 600, left: 200, right: 900, bottom: 640 };

    const short = computeOverlayPlacement(anchor, 1000, 800, 100);
    expect(short.top).toBe(anchor.bottom + 12);
    expect(short.bottom).toBeNull();

    const tall = computeOverlayPlacement(anchor, 1000, 800, 300);
    expect(tall.top).toBeNull();
    expect(tall.bottom).toBe(800 - anchor.top + 12);
  });

  it('shifts the panel up rather than let it overflow the bottom of the viewport as it grows (#387)', () => {
    // The real page this was measured on: viewport 1591x908, a comment
    // composer near the bottom of a long feed with plenty of room to its
    // right but almost none below its own top edge. The old rule placed the
    // panel at `top: anchor.top` unconditionally and only ever *capped*
    // its height, which floored out at a constant `OVERLAY_MIN_HEIGHT` -
    // 814 + 160 ran 66px past the 908-tall viewport.
    const anchor = { top: 814, left: 300, right: 560, bottom: 854 };
    const viewport = { width: 1591, height: 908 };

    const skeleton = computeOverlayPlacement(anchor, viewport.width, viewport.height, 116);
    expect(skeleton.top).not.toBeNull();
    expect(skeleton.top! + 116).toBeLessThanOrEqual(viewport.height - 12);

    const grown = computeOverlayPlacement(anchor, viewport.width, viewport.height, 160);
    expect(grown.top).not.toBeNull();
    expect(grown.top! + 160).toBeLessThanOrEqual(viewport.height - 12);
    // Not just coincidentally safe: it actually shifted off the anchor's own
    // top edge to make room.
    expect(grown.top!).toBeLessThan(anchor.top);
  });
});

describe('mountPanel, overlay wiring', () => {
  it('positions the host from the anchor\u2019s rect and repositions it on scroll', async () => {
    const anchor = anchorEl();
    stubViewport(
      anchor,
      { top: 100, left: 300, right: 560, bottom: 140 },
      { width: 1200, height: 800 },
    );

    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    const host = handle.shadow.host as HTMLElement;
    expect(host.style.top).toBe('100px');

    stubViewport(
      anchor,
      { top: 400, left: 300, right: 560, bottom: 440 },
      { width: 1200, height: 800 },
    );
    window.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(host.style.top).toBe('400px'));

    handle.destroy();
  });

  it('repositions on window resize', async () => {
    const anchor = anchorEl();
    stubViewport(
      anchor,
      { top: 100, left: 900, right: 1160, bottom: 140 },
      { width: 1200, height: 800 },
    );

    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    const host = handle.shadow.host as HTMLElement;
    // 1200-wide viewport, anchor near the right edge: fits below, not right.
    expect(host.style.top).toBe(`${140 + 12}px`);

    // A narrower window opens room to the anchor's right that was not there
    // before.
    stubViewport(
      anchor,
      { top: 100, left: 900, right: 1160, bottom: 140 },
      { width: 1700, height: 800 },
    );
    window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(host.style.top).toBe('100px'));

    handle.destroy();
  });

  it('repositions when the panel\u2019s own height grows, keeping the bottom inside the viewport (#387)', () => {
    const fakeResize = installFakeResizeObserver();
    const anchor = anchorEl();
    const viewport = { width: 1591, height: 908 };
    // Same corner as the real-page report: room to the anchor's right, but
    // almost none below its own top edge.
    stubViewport(anchor, { top: 814, left: 300, right: 560, bottom: 854 }, viewport);

    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    const host = handle.shadow.host as HTMLElement;

    // Before any real measurement (jsdom lays nothing out), `positionOverlay`
    // falls back to the shortest useful height, which already has to shift
    // off `anchor.top` (814) to fit a 908-tall viewport.
    expect(host.style.top).toBe('736px');

    // The draft streams in and the panel grows to 300px - taller than the
    // fallback assumed. Nothing but the host's own `ResizeObserver` can know
    // this happened.
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 440,
      bottom: 300,
      width: 440,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fakeResize.forTarget(host);

    expect(host.style.top).toBe('596px');
    const top = Number.parseFloat(host.style.top);
    expect(top + 300).toBeLessThanOrEqual(viewport.height - 12);

    handle.destroy();
  });

  it('calls onDismiss on Escape', () => {
    const anchor = anchorEl();
    stubViewport(anchor, { top: 0, left: 0, right: 0, bottom: 0 }, { width: 1200, height: 800 });
    const onDismiss = vi.fn();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' }, onDismiss });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('calls onDismiss on a pointer-down outside the panel, but not inside it', () => {
    const anchor = anchorEl();
    stubViewport(anchor, { top: 0, left: 0, right: 0, bottom: 0 }, { width: 1200, height: 800 });
    const onDismiss = vi.fn();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' }, onDismiss });

    const inside = handle.shadow.querySelector('.probe') as HTMLElement;
    inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(onDismiss).not.toHaveBeenCalled();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('stops calling onDismiss once destroyed, proving the listeners are actually removed', () => {
    const anchor = anchorEl();
    stubViewport(anchor, { top: 0, left: 0, right: 0, bottom: 0 }, { width: 1200, height: 800 });
    const onDismiss = vi.fn();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' }, onDismiss });
    handle.destroy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
