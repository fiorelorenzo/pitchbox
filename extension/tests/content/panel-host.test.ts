// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Component } from 'svelte';
import {
  mountPanel,
  panelFor,
  forgetMountedForTests,
} from '../../src/content/shared/panel-host.js';

/**
 * Lifecycle and isolation for the in-page panel host.
 *
 * Two of its imports only exist inside Vite: `../panel.css?inline` (the
 * compiled stylesheet as a string) and the `?url` font asset. Plain vitest
 * cannot resolve either, so both are stubbed here. That is the only thing
 * stubbed: the shadow root, the mount, the observer and the teardown are all
 * real, running against jsdom.
 */
vi.mock('../../src/content/panel.css?inline', () => ({
  default: ':host{display:block}.pitchbox-panel{color:var(--foreground)}',
}));
vi.mock('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url', () => ({
  default: 'assets/inter.woff2',
}));

/**
 * A stand-in for the panel's Svelte component. `mount()` invokes a client
 * component as `(anchor, props)`, where `anchor` is a node inside the target,
 * so rendering by hand here keeps the test free of the Svelte compiler (the
 * root vitest config has no svelte plugin) while still going through the real
 * `mount`/`unmount` pair.
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

// Svelte's `Component` type describes a compiler output, which a hand-written
// function cannot satisfy structurally; the call shape above is what `mount`
// actually requires.
const Probe = probeComponent as unknown as Component<{ label: string }>;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // jsdom has no FontFace; the host is required to treat that as cosmetic.
  // Deleting it per test proves the mount still succeeds without one.
  // @ts-expect-error deliberately removing an optional global
  delete globalThis.FontFace;
});

// A test that never calls `destroy()` leaves its `window`/`document` listeners
// live past the test. Without this, the last such test in the file leaves a
// `MutationObserver` armed against a DOM that Vitest tears down before the
// next `beforeEach` ever runs, and it fires mid-teardown against a `window`
// that is already gone (#386's overlay dismissal added the first listeners
// `mountPanel` puts on `window`/`document` rather than just on the anchor).
afterEach(() => {
  document.body.innerHTML = '';
});

function anchorEl(): HTMLElement {
  const post = document.createElement('article');
  post.setAttribute('data-urn', 'urn:li:activity:1');
  document.body.append(post);
  return post;
}

describe('mountPanel', () => {
  it('renders into a shadow root and never into the host document', () => {
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });

    const host = document.querySelector('pitchbox-panel-host');
    expect(host).not.toBeNull();
    expect(handle.shadow).toBe(host!.shadowRoot);
    // The panel's content is inside the shadow tree, so a document-level query
    // cannot see it. That is the isolation guarantee, asserted rather than
    // assumed.
    expect(document.querySelector('.probe')).toBeNull();
    expect(handle.shadow.querySelector('.probe')).not.toBeNull();
  });

  it('puts the panel root inside the shadow root and follows the host page (LOR-211)', async () => {
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });

    // The root sits inside the shadow root so `.dark` can select the dark
    // token values for its descendants (a shadow descendant cannot match
    // `.dark *` when the `.dark` element is the host). Which values it
    // selects is the host page's call now, not a constant: this document
    // paints nothing, so it reads as light.
    const root = handle.shadow.querySelector('.pitchbox-panel');
    expect(root).not.toBeNull();
    expect(root!.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // And it tracks a flip that happens with the panel already open, which
    // is what LinkedIn's own dark-mode switch does: no reload.
    document.body.setAttribute('style', 'background-color: rgb(27, 31, 35)');
    await vi.waitFor(() => expect(root!.classList.contains('dark')).toBe(true));
  });

  it('takes the dark palette when the page it mounts on is already dark', () => {
    document.body.setAttribute('style', 'background-color: rgb(27, 31, 35)');
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });

    const root = handle.shadow.querySelector('.pitchbox-panel');
    expect(root!.classList.contains('dark')).toBe(true);
  });

  it('adds its stylesheet to the shadow root and nothing to the document head', () => {
    const anchor = anchorEl();
    const before = document.head.innerHTML;
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });

    const adopted = handle.shadow.adoptedStyleSheets ?? [];
    const inlineStyle = handle.shadow.querySelector('style');
    // One or the other, depending on whether the engine has constructable
    // stylesheets; both are scoped to the shadow root.
    expect(adopted.length > 0 || inlineStyle !== null).toBe(true);
    expect(document.head.innerHTML).toBe(before);
  });

  it('appends the host to document.body as a floating overlay, not next to the anchor (D13)', () => {
    // Nested rather than a direct child of body: this is what actually
    // distinguishes an overlay from a sibling insert, since a host appended
    // to `document.body` and a host inserted `afterend` on a body-level
    // anchor would land in the same place.
    const container = document.createElement('div');
    document.body.append(container);
    const anchor = document.createElement('article');
    container.append(anchor);

    mountPanel({ anchor, component: Probe, props: { label: 'a' } });

    const host = document.querySelector('pitchbox-panel-host');
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(document.body);
    expect(container.contains(host)).toBe(false);
    expect((host as HTMLElement).style.position).toBe('fixed');
  });

  it('returns the existing panel instead of stacking a second one on the same anchor', () => {
    const anchor = anchorEl();
    const first = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    const second = mountPanel({ anchor, component: Probe, props: { label: 'b' } });

    // Exactly one panel per acted-on post.
    expect(second).toBe(first);
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
  });

  it('mounts a second panel only on a different anchor', () => {
    const a = anchorEl();
    const b = anchorEl();
    const first = mountPanel({ anchor: a, component: Probe, props: { label: 'a' } });
    const second = mountPanel({ anchor: b, component: Probe, props: { label: 'b' } });
    expect(second).not.toBe(first);
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(2);
  });

  it('replaces a stale host left by another script instance on the same anchor (#476)', () => {
    // Reproduces the real defect: an extension reload leaves the pre-reload
    // content script's isolated world running, with its own `mounted` map
    // that a fresh post-reload instance never sees, but both worlds share
    // one DOM. `forgetMountedForTests` simulates that world boundary without
    // an actual second realm - the anchor and the stale host both stay real
    // DOM nodes, only this module's own bookkeeping forgets them.
    const anchor = anchorEl();
    const stale = mountPanel({ anchor, component: Probe, props: { label: 'stale' } });
    forgetMountedForTests();

    const fresh = mountPanel({ anchor, component: Probe, props: { label: 'fresh' } });

    expect(fresh).not.toBe(stale);
    const hosts = document.querySelectorAll('pitchbox-panel-host');
    expect(hosts.length).toBe(1);
    expect(hosts[0]).toBe(fresh.shadow.host);
  });

  it("a superseded panel's own update cannot render it back over the live one (#476)", () => {
    const anchor = anchorEl();
    const stale = mountPanel({ anchor, component: Probe, props: { label: 'stale' } });
    forgetMountedForTests();
    const live = mountPanel({ anchor, component: Probe, props: { label: 'live' } });

    // The superseded handle is still a live JS object in its own (simulated)
    // realm: its in-flight request can still resolve and call update() on it
    // well after being superseded. That must not put its content back on
    // screen, even though update() itself does not throw or refuse.
    expect(() => stale.update({ label: 'stale, updated after being superseded' })).not.toThrow();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
    expect(document.body.contains(stale.shadow.host)).toBe(false);
    expect(document.querySelector('pitchbox-panel-host')).toBe(live.shadow.host);
  });

  it('mounts even when the FontFace API is missing', () => {
    // Inter failing to register is a cosmetic defect covered by the fallback
    // stack; a panel that refused to appear would be a broken feature.
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    expect(handle.alive).toBe(true);
    expect(handle.shadow.querySelector('.probe')).not.toBeNull();
  });
});

describe('destroy', () => {
  it('removes the host element and reports itself dead', () => {
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    handle.destroy();

    expect(handle.alive).toBe(false);
    expect(document.querySelector('pitchbox-panel-host')).toBeNull();
    expect(panelFor(anchor)).toBeNull();
  });

  it('is idempotent', () => {
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    handle.destroy();
    expect(() => handle.destroy()).not.toThrow();
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(0);
  });

  it('lets a fresh panel mount on the same anchor afterwards', () => {
    const anchor = anchorEl();
    mountPanel({ anchor, component: Probe, props: { label: 'a' } }).destroy();
    const again = mountPanel({ anchor, component: Probe, props: { label: 'b' } });
    expect(again.alive).toBe(true);
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
  });

  it('stops updating once destroyed', () => {
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    handle.destroy();
    expect(() => handle.update({ label: 'b' })).not.toThrow();
  });
});

describe('single-page navigation', () => {
  it('destroys itself when its anchor leaves the document', async () => {
    const anchor = anchorEl();
    const onDetached = vi.fn();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' }, onDetached });

    // LinkedIn recycles feed nodes and changes route without a reload, which is
    // how an orphaned panel would otherwise survive.
    anchor.remove();
    await vi.waitFor(() => expect(handle.alive).toBe(false));

    expect(document.querySelector('pitchbox-panel-host')).toBeNull();
    expect(onDetached).toHaveBeenCalledTimes(1);
  });

  it('does not stack panels when the same anchor is replaced by a new node', async () => {
    const first = anchorEl();
    const handle = mountPanel({ anchor: first, component: Probe, props: { label: 'a' } });
    first.remove();
    await vi.waitFor(() => expect(handle.alive).toBe(false));

    const second = anchorEl();
    mountPanel({ anchor: second, component: Probe, props: { label: 'b' } });
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
  });
});
