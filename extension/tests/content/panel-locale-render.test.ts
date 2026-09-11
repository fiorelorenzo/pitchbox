// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import PostAssistPanel from '../../src/content/linkedin-post-assist-panel.svelte';
import { setLocale } from '../../src/lib/i18n/index.js';
import type { PostAssistPanelProps } from '../../src/content/linkedin-post-assist.js';

/**
 * LOR-261: proves the missing half of the bug directly against a real
 * compiled component, on the root `vitest.config.ts` (what CI's `quality`
 * job and the pre-push `preflight` hook both run) rather than the
 * extension's own workspace config - see AGENTS.md's "Mounting a side-panel
 * component in a test" note for why that distinction matters (#339, #457).
 *
 * `linkedin-post-assist.ts`'s panel already called `$t()` for every string
 * before this issue - the dictionary and the render were never the problem.
 * What was missing is something ever handing the panel a locale other than
 * DEFAULT_LOCALE; that resolution is covered end to end (content script to
 * mounted panel) in `linkedin-post-assist-locale.test.ts`. This test isolates
 * the other half: once the locale store holds a real preference, the panel
 * genuinely renders in it, in both directions, against the compiled
 * component the content script actually mounts.
 */

let host: HTMLElement;
let component: object | null = null;

function noop(): void {
  // Panel callbacks the resting phase never invokes in this test.
}

function render(): string {
  const props: PostAssistPanelProps = {
    state: { phase: 'resting' },
    onRequest: noop,
    onEditChange: noop,
    onAccept: noop,
    onRetune: noop,
    onDismiss: noop,
  };
  component = mount(PostAssistPanel, { target: host, props });
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  setLocale('en');
});

describe('the post-assist panel renders the locale it is handed (LOR-261)', () => {
  it('renders Italian once the locale store holds it', () => {
    host = document.createElement('div');
    document.body.append(host);
    setLocale('it');

    const text = render();

    expect(text).toContain('Ottieni un post suggerito da Pitchbox per la tua rete.');
    expect(text).toContain('Suggerisci un post');
    expect(text).not.toContain('Get a Pitchbox-suggested post');
  });

  it('renders English when the locale store holds the default', () => {
    host = document.createElement('div');
    document.body.append(host);
    setLocale('en');

    const text = render();

    expect(text).toContain('Get a Pitchbox-suggested post for your network.');
    expect(text).toContain('Suggest a post');
    expect(text).not.toContain('Ottieni un post suggerito');
  });
});
