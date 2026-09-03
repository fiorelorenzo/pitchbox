// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Component } from 'svelte';
import { mountPanel, panelFor } from '../../src/content/shared/panel-host.js';

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

  it('puts the dark panel root inside the shadow root, not on the host page', () => {
    const anchor = anchorEl();
    const handle = mountPanel({ anchor, component: Probe, props: { label: 'a' } });

    // D10: the panel is always the dark palette regardless of LinkedIn's
    // theme, and `.dark` sits inside the shadow root so Tailwind's `dark:`
    // variant can match it (a shadow descendant cannot match `.dark *` when
    // the `.dark` element is the host).
    const root = handle.shadow.querySelector('.pitchbox-panel');
    expect(root).not.toBeNull();
    expect(root!.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
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

  it('inserts the host after its anchor, so the panel is anchored to the post', () => {
    const anchor = anchorEl();
    mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    expect(anchor.nextElementSibling?.tagName.toLowerCase()).toBe('pitchbox-panel-host');
  });

  it('returns the existing panel instead of stacking a second one on the same anchor', () => {
    const anchor = anchorEl();
    const first = mountPanel({ anchor, component: Probe, props: { label: 'a' } });
    const second = mountPanel({ anchor, component: Probe, props: { label: 'b' } });

    // D11: exactly one panel per acted-on post.
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
