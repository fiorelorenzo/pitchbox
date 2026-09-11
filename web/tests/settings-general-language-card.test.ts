// @vitest-environment jsdom
//
// 2026-09-12 UI/UX defects batch: the display-language picker folded from
// its own /settings/language page into a card on /settings/general
// (SettingsLanguageCard.svelte). This drives the real, compiled component
// exactly the way the old settings-language page test would have: read the
// rendered trigger, click through the actual bits-ui `Select`, and confirm
// the same POST /api/auth/locale write LOR-262 always used still fires with
// the picked locale, then that a save failure reverts the visible selection
// instead of leaving the trigger showing a value the account never accepted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SettingsLanguageCard from '../src/lib/components/settings/SettingsLanguageCard.svelte';
import { __page } from './support/app-stores.js';
import { invalidateAll } from './support/app-navigation.js';

function pointerEvent(type: string) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
  });
}

let component: Record<string, unknown> | null = null;
let fetchMock: Mock;

function render(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  component = mount(SettingsLanguageCard, { target: host }) as Record<string, unknown>;
  // Same "let the closed-state pass run first" flush the campaign voice
  // form test needs for bits-ui's `Select` - without it the trigger click
  // below is mistaken for the skipped initial reactive pass and the
  // listbox never opens.
  flushSync();
  return host;
}

function languageTrigger(el: HTMLElement): HTMLButtonElement {
  const trigger = Array.from(el.querySelectorAll('button')).find((b) =>
    ['English', 'Italiano'].includes(b.textContent?.trim() ?? ''),
  );
  if (!trigger) throw new Error('language select trigger not found');
  return trigger;
}

function selectLanguageOption(el: HTMLElement, optionText: string) {
  languageTrigger(el).dispatchEvent(pointerEvent('pointerdown'));
  flushSync();
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (o) => o.textContent?.trim() === optionText,
  );
  if (!option) throw new Error(`language option "${optionText}" not found`);
  option.dispatchEvent(pointerEvent('pointerup'));
  flushSync();
}

async function postedLocale(): Promise<string> {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0] as Parameters<typeof fetch>;
  expect(url).toBe('/api/auth/locale');
  const sentBody = JSON.parse(init?.body as string) as { locale: string };
  return sentBody.locale;
}

beforeEach(() => {
  __page.set({ data: { locale: 'en' } });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  invalidateAll.mockClear();
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SettingsLanguageCard: the folded-in /settings/general picker still writes the account locale', () => {
  it('shows the account locale on load', () => {
    const el = render();
    expect(languageTrigger(el).textContent).toContain('English');
  });

  it('picking Italiano POSTs /api/auth/locale with locale "it" and refreshes the page data', async () => {
    const el = render();
    selectLanguageOption(el, 'Italiano');
    expect(await postedLocale()).toBe('it');
    await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalled());
  });

  it('reverts the visible selection when the save fails', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    const el = render();
    selectLanguageOption(el, 'Italiano');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(languageTrigger(el).textContent).toContain('English'));
  });
});
