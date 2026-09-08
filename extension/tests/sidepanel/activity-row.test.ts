// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mount, unmount } from 'svelte';
import ActivityRow from '../../src/sidepanel/components/ActivityRow.svelte';
import type { ActivityEvent } from '../../src/lib/activity.js';

/**
 * #452: an activity error/warn row that has exactly one action offers it as
 * a button; a row that does not stays a sentence with nothing to click.
 * Against the real compiled component (not resolveActivityAction in
 * isolation) - the bug #452 fixes is exactly a UI that renders nothing
 * clickable, so the proof has to be the rendered DOM.
 */
type ChromeStub = {
  storage: { local: { get: Mock } };
  tabs: { create: Mock };
  runtime: { sendMessage: Mock };
  permissions: { request: Mock };
};

// Same named-const pattern as inject-open-tabs.test.ts/linkedin-registration-matches.test.ts:
// the global's `chrome` typed as the real ambient `chrome`, assigned from a
// stub that only implements the surface this component actually calls.
const globalWithChrome = globalThis as unknown as { chrome: typeof chrome };

let host: HTMLElement;
let component: Record<string, unknown> | null = null;
let chromeStub: ChromeStub;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
  chromeStub = {
    storage: {
      local: {
        get: vi
          .fn()
          .mockResolvedValue({ pairings: [{ backendUrl: 'https://paired.example', token: 't' }] }),
      },
    },
    tabs: { create: vi.fn() },
    runtime: {
      sendMessage: vi.fn((_msg: unknown, cb?: (r: unknown) => void) => cb?.({ ok: true })),
    },
    permissions: { request: vi.fn().mockResolvedValue(true) },
  };
  globalWithChrome.chrome = chromeStub as unknown as typeof chrome;
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

function baseEvent(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: '01',
    ts: new Date().toISOString(),
    level: 'error',
    source: 'dm-sync',
    message: 'activity.dm-sync.error',
    messageParams: { reason: 'http 500' },
    ...over,
  };
}

function render(event: ActivityEvent, linkedInGranted = true): HTMLElement {
  component = mount(ActivityRow, {
    target: host,
    props: { event, linkedInGranted },
  }) as Record<string, unknown>;
  return host;
}

describe('ActivityRow action affordance', () => {
  it('a non-actionable row (a DOM timing miss) renders no button', () => {
    const el = render(
      baseEvent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.comment-box-missing',
        messageParams: { draftId: 1 },
      }),
    );
    expect(el.querySelector('button')).toBeNull();
  });

  it('a sync failure renders a "Retry sync now" button', () => {
    const el = render(baseEvent());
    const btn = el.querySelector('button');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Retry sync now');
  });

  it('clicking the retry-sync button re-runs the sync via the background worker', async () => {
    const el = render(baseEvent());
    el.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'pitchbox:dm-sync:run' },
      expect.any(Function),
    );
  });

  it('an unauthorized reddit-action row renders "Open reddit.com" and opens it on click', async () => {
    const el = render(
      baseEvent({
        level: 'warn',
        source: 'dm-sync',
        message: 'activity.dm-sync.unauthorized',
        messageParams: { reason: 'not-logged-in' },
      }),
    );
    const btn = el.querySelector('button');
    expect(btn?.textContent).toContain('Open reddit.com');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(chromeStub.tabs.create).toHaveBeenCalledWith({ url: 'https://www.reddit.com/' });
  });

  it('a backend flip failure opens the paired backend on click', async () => {
    const el = render(
      baseEvent({
        source: 'reddit-action',
        message: 'activity.reddit-action.fail',
        messageParams: { draftId: 1, reason: 'http 500' },
      }),
    );
    el.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(chromeStub.tabs.create).toHaveBeenCalledWith({ url: 'https://paired.example' });
    });
  });

  it('a refusal naming the kill switch opens the assist settings page on click', async () => {
    const el = render(
      baseEvent({
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.suggestion-refused',
        messageParams: { reason: 'kill_switch' },
      }),
    );
    const btn = el.querySelector('button');
    expect(btn?.textContent).toContain('Open assist settings');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(chromeStub.tabs.create).toHaveBeenCalledWith({
        url: 'https://paired.example/settings/linkedin-assist',
      });
    });
  });

  it('a LinkedIn row with access currently off offers turning it back on, and the click requests the permission synchronously', async () => {
    const el = render(
      baseEvent({
        level: 'warn',
        source: 'linkedin-dom',
        message: 'activity.linkedin-dom.selector-miss',
        messageParams: { selector: '.x', pageKind: 'feed', misses: 3, matches: 0 },
      }),
      false,
    );
    const btn = el.querySelector('button');
    expect(btn?.textContent).toContain('Turn LinkedIn access back on');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(chromeStub.permissions.request).toHaveBeenCalledWith({
      origins: ['*://*.linkedin.com/*'],
    });
  });

  it('the same LinkedIn row with access on gets no button (a layout drift, not a setting)', () => {
    const el = render(
      baseEvent({
        level: 'warn',
        source: 'linkedin-dom',
        message: 'activity.linkedin-dom.selector-miss',
        messageParams: { selector: '.x', pageKind: 'feed', misses: 3, matches: 0 },
      }),
      true,
    );
    expect(el.querySelector('button')).toBeNull();
  });
});
