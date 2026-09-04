// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountPanel } from '../../src/content/shared/panel-host.js';
import PanelFrame from '../../src/content/panel-frame.svelte';

/**
 * `panel-host.ts`'s `update()` against a real compiled component, which is the
 * only way to see whether a panel actually re-renders.
 *
 * This exists because it did not. `update()` shipped as
 * `Object.assign(props, next)` on a plain object, with a comment asserting
 * that Svelte 5 reads props reactively from the object it was handed. It does
 * not: mutating a plain props object notifies nothing. The panel's whole state
 * machine (streaming, ready, refused) is delivered through this call, so the
 * in-page assistant could never leave its resting state (#369).
 *
 * `panel-host.test.ts` could not have caught it. Its stand-in component is a
 * hand-written function that renders once, so re-rendering is unobservable
 * there, and its only assertion about `update` is that it does not throw,
 * which a no-op satisfies perfectly.
 */

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // jsdom has no FontFace, and the host treats that as cosmetic.
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'FontFace');
});

function anchorEl(): HTMLElement {
  const el = document.createElement('article');
  document.body.append(el);
  return el;
}

function panelText(shadow: ShadowRoot): string {
  return (shadow.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('panel-host update, against a real component', () => {
  it('re-renders the component when a prop changes', async () => {
    const anchor = anchorEl();
    const handle = mountPanel({
      anchor,
      component: PanelFrame,
      props: { subject: 'Giulia Bianchi' },
    });

    expect(panelText(handle.shadow)).toContain('Giulia Bianchi');

    handle.update({ subject: 'Marco Rossi' });
    await Promise.resolve();

    expect(panelText(handle.shadow)).toContain('Marco Rossi');
    expect(panelText(handle.shadow)).not.toContain('Giulia Bianchi');
  });

  it('keeps re-rendering across several updates, so a state machine can drive it', async () => {
    const anchor = anchorEl();
    const handle = mountPanel({
      anchor,
      component: PanelFrame,
      props: { subject: 'first' },
    });

    for (const subject of ['second', 'third', 'fourth']) {
      handle.update({ subject });
      await Promise.resolve();
      expect(panelText(handle.shadow)).toContain(subject);
    }
  });

  it('still refuses to update once destroyed, and leaves no host behind', async () => {
    const anchor = anchorEl();
    const handle = mountPanel({
      anchor,
      component: PanelFrame,
      props: { subject: 'before' },
    });
    handle.destroy();

    expect(() => handle.update({ subject: 'after' })).not.toThrow();
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(0);
  });
});
