// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import HomeStateLine from '../../src/sidepanel/components/HomeStateLine.svelte';
import { homeState, type HomeState } from '../../src/lib/home-state.js';
import type { Pairing } from '../../src/lib/storage.js';

/**
 * The state line against the real compiled component, because the derivation
 * being right is not the same as the operator reading a sentence: a missing
 * dictionary entry, or a detail line the markup drops, both render as an
 * honest-looking panel that answers nothing.
 *
 * Kept to this one component on purpose. The whole home surface needs
 * chrome.alarms/storage/permissions to mount, and the proof that it works is
 * driving the built extension in a real profile (#400's own acceptance), not
 * a jsdom double.
 */
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

function render(state: HomeState): string {
  component = mount(HomeStateLine, { target: host, props: { state } }) as Record<string, unknown>;
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function pairing(over: Partial<Pairing> = {}): Pairing {
  return {
    backendUrl: 'https://preview.pitchbox.app',
    token: 't',
    lastHandshakeAt: new Date(NOW - 60_000).toISOString(),
    syncStatus: {
      chat: 'ok',
      legacy: 'ok',
      capturedAt: new Date(NOW - 60_000).toISOString(),
    },
    ...over,
  };
}

describe('the home state line', () => {
  it('renders the state and the thing that set it as sentences, not keys', () => {
    const text = render(
      homeState(
        {
          pairings: [
            pairing({ syncStatus: { chat: 'unauthorized', legacy: 'ok', capturedAt: '' } }),
          ],
          linkedInGranted: true,
        },
        NOW,
      ),
    );
    expect(text).toContain('Needs attention');
    expect(text).toContain('Reddit Chat is not syncing on preview.pitchbox.app');
    expect(text).not.toContain('home.state');
  });

  it('carries the tone on the element, so a screenshot and a test see the same state', () => {
    render(homeState({ pairings: [pairing()], linkedInGranted: true }, NOW));
    expect(host.querySelector('[data-home-state]')?.getAttribute('data-home-state')).toBe('ok');
  });

  it('a first run reads as a first run and not as a failure', () => {
    const text = render(homeState({ pairings: [], linkedInGranted: false }, NOW));
    expect(text).toContain('Not paired');
    expect(host.querySelector('[data-home-state="idle"]')).toBeTruthy();
    // The amber and red dots both mean something is wrong; a first run must
    // not borrow either.
    expect(host.querySelector('.bg-amber-500, .bg-red-500')).toBeNull();
  });

  it('a pairing waiting for its first sync is not painted as a warning (#383)', () => {
    const fresh = pairing({ syncStatus: undefined });
    const text = render(homeState({ pairings: [fresh], linkedInGranted: true }, NOW));
    expect(text).toContain('Not synced yet');
    expect(host.querySelector('.bg-amber-500, .bg-red-500')).toBeNull();
  });

  it('a permission Chrome removed renders red with the sentence that names it', () => {
    const text = render(
      homeState(
        {
          pairings: [pairing()],
          linkedInGranted: false,
          linkedInRevokedAt: new Date(NOW - 1000).toISOString(),
        },
        NOW,
      ),
    );
    expect(text).toContain('LinkedIn access was removed');
    expect(host.querySelector('.bg-red-500')).toBeTruthy();
  });
});
