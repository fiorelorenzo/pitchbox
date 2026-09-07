// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Component } from 'svelte';
import { mountPanel, computeOverlayPlacement } from '../../src/content/shared/panel-host.js';

/**
 * Overlay placement and dismissal for the in-page panel host (D13, #386).
 *
 * `computeOverlayPlacement` is tested directly rather than through a mounted
 * host: jsdom's layout engine returns a zeroed-out rect for every element
 * unless `getBoundingClientRect` is stubbed, which would make any assertion
 * on the *numbers* `panel-host.ts` derives from a real anchor either
 * meaningless (stubbed to whatever the test wants) or untestable (unstubbed,
 * always zero). The placement rule itself has real branches - right, then
 * below, then above - and those are what this file proves, both in the pure
 * function and, for the DOM wiring around it, against a mounted host.
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

// See panel-host.test.ts for why this matters: an undestroyed handle leaves
// window/document listeners armed past the test, and the last one in the
// file fires its MutationObserver mid-teardown against a torn-down window.
afterEach(() => {
  document.body.innerHTML = '';
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

describe('computeOverlayPlacement', () => {
  it('prefers the anchor\u2019s right side when there is room', () => {
    const placement = computeOverlayPlacement(
      { top: 100, left: 300, right: 560, bottom: 140 },
      1200,
      800,
    );
    expect(placement.top).toBe(100);
    expect(placement.bottom).toBeNull();
    expect(placement.left).toBe(560 + 12);
  });

  it('flips to below the anchor, pulled left of a naive alignment, when the anchor is near the right edge', () => {
    // 1180 of a 1200-wide viewport: 8px to the right, nowhere near the
    // panel's ~440px width.
    const anchor = { top: 100, left: 1000, right: 1180, bottom: 140 };
    const placement = computeOverlayPlacement(anchor, 1200, 800);

    expect(placement.top).toBe(anchor.bottom + 12);
    expect(placement.bottom).toBeNull();
    // Aligned to the anchor's left edge in principle, but clamped inside the
    // viewport - a 440px-wide panel at left:1000 in a 1200-wide viewport
    // would run 252px past the right edge.
    expect(placement.left).toBeLessThan(anchor.left);
    expect(placement.left + 440).toBeLessThanOrEqual(1200);
  });

  it('flips above the anchor when there is not enough room to the side or below', () => {
    // Same right-edge squeeze as above, plus the anchor sits 8px above the
    // bottom of the viewport too.
    const anchor = { top: 740, left: 1000, right: 1180, bottom: 780 };
    const placement = computeOverlayPlacement(anchor, 1200, 800);

    expect(placement.top).toBeNull();
    expect(placement.bottom).toBe(800 - anchor.top + 12);
  });

  it('never places the panel outside the viewport, even when the viewport is narrower than the panel', () => {
    const anchor = { top: 50, left: -40, right: 20, bottom: 90 };
    const placement = computeOverlayPlacement(anchor, 300, 800);

    expect(placement.left).toBeGreaterThanOrEqual(12);
    expect(placement.left).toBeLessThanOrEqual(300 - 12);
  });

  it('narrows the width on a narrow window, mirroring panel.css\u2019s min(440px, 100vw - 24px)', () => {
    // Far enough right that it never fits beside the anchor in either
    // viewport, so `left` always clamps to `viewportWidth - width - margin`
    // and reads back the width the placement actually used.
    const anchor = { top: 0, left: 5000, right: 5050, bottom: 40 };

    const wide = computeOverlayPlacement(anchor, 1200, 800);
    // width is the unclamped 440px default: left = 1200 - 440 - 12.
    expect(wide.left).toBe(1200 - 440 - 12);

    const narrow = computeOverlayPlacement(anchor, 380, 800);
    // width is min(440, 380 - 24) = 356, which puts the panel flush against
    // the viewport's own margin: left = 380 - 356 - 12 = 12.
    expect(narrow.left).toBe(12);
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
