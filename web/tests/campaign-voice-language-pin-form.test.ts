// @vitest-environment jsdom
//
// LOR-290: `RedditCommenterVoiceForm.svelte`'s `V` type had no `language`
// field and nothing rendered a control for `campaign.config.voice.language`
// (the pin LOR-265 added to the schema), so the only way to set it was
// editing the database directly. `shared/tests/campaigns/scenario-schemas.test.ts`
// and the PATCH route already accept the field happily on `origin/main` -
// that was never the gap, which is why a schema or route test cannot prove
// this fix. This test drives the real, compiled `CampaignProfileTab.svelte`
// (the same component the campaign detail page mounts) exactly the way an
// operator would: read the rendered control, click through the actual
// bits-ui `Select`, and click the real Save button that calls the tab's own
// `save()` - the "form's own action". It fails on `origin/main` because the
// language `SelectField` does not exist at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import CampaignProfileTab from '../src/lib/components/campaigns/CampaignProfileTab.svelte';
import { __page } from './support/app-stores.js';
import { invalidateAll } from './support/app-navigation.js';

vi.mock('$lib/realtime/sse', () => ({
  getSseManager: () => ({
    on: () => () => {},
    close: () => {},
    getStatus: () => 'live',
    subscribeStatus: () => () => {},
    lastEventAt: () => Date.now(),
  }),
  connectionKeyFor: (status: string) => (status === 'live' ? 'live' : 'idle'),
}));

type VoiceOverrides = { language?: 'en' | 'it' };

function baseConfig(voiceOverrides: VoiceOverrides = {}) {
  return {
    targetSubreddits: ['sysadmin'],
    topicKeywords: ['backup'],
    avoidKeywords: ['spam'],
    voice: {
      tone: 'casual',
      hardBans: [],
      dos: [],
      disclosure: 'Affiliated with Acme.',
      ...voiceOverrides,
    },
    valuePropositions: ['saves time'],
    productUrl: 'https://example.com',
    systemInstructions: 'Be helpful.',
  };
}

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

function render(initialConfig: Record<string, unknown>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  component = mount(CampaignProfileTab, {
    target: host,
    props: { campaignId: 1, scenarioSlug: 'reddit-commenter', initialConfig, skillRuns: [] },
  }) as Record<string, unknown>;
  // The trigger's own presence-driven popper layer skips its very first
  // reactive pass (a deliberate "don't animate on mount" guard in bits-ui's
  // `PresenceManager`) - without a flush here to let that pass run against
  // the closed state, the *next* state change it ever observes is "already
  // open" and is mistaken for the skipped initial one, so the listbox never
  // actually renders on the click below.
  flushSync();
  return host;
}

function languageTrigger(el: HTMLElement): HTMLButtonElement {
  const trigger = Array.from(el.querySelectorAll('button')).find((b) =>
    ['Match the post', 'English', 'Italian'].includes(b.textContent?.trim() ?? ''),
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

function clickSave(el: HTMLElement) {
  const saveButton = Array.from(el.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Save'),
  );
  if (!saveButton) throw new Error('save button not found');
  saveButton.click();
}

async function patchedVoice(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0] as Parameters<typeof fetch>;
  expect(url).toBe('/api/campaigns/1');
  const sentBody = JSON.parse(init?.body as string) as {
    config: { voice: Record<string, unknown> };
  };
  return sentBody.config.voice;
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

describe('LOR-290: campaign voice form language pin round-trips through the save action', () => {
  it('shows "Match the post" when no pin is stored (the default)', () => {
    const el = render(baseConfig());
    expect(languageTrigger(el).textContent).toContain('Match the post');
  });

  it('shows "English" on load when the campaign already has an English pin', () => {
    const el = render(baseConfig({ language: 'en' }));
    expect(languageTrigger(el).textContent).toContain('English');
  });

  it('shows "Italian" on load when the campaign already has an Italian pin', () => {
    const el = render(baseConfig({ language: 'it' }));
    expect(languageTrigger(el).textContent).toContain('Italian');
  });

  it('picking English and saving PATCHes config.voice.language as "en"', async () => {
    const el = render(baseConfig());
    selectLanguageOption(el, 'English');
    clickSave(el);
    expect(await patchedVoice()).toMatchObject({ language: 'en' });
  });

  it('picking Italian and saving PATCHes config.voice.language as "it"', async () => {
    const el = render(baseConfig());
    selectLanguageOption(el, 'Italian');
    clickSave(el);
    expect(await patchedVoice()).toMatchObject({ language: 'it' });
  });

  it('picking "Match the post" on a previously-pinned campaign clears the pin - three states, not a two-state toggle', async () => {
    const el = render(baseConfig({ language: 'it' }));
    selectLanguageOption(el, 'Match the post');
    clickSave(el);
    const voice = await patchedVoice();
    expect(voice).not.toHaveProperty('language');
  });
});
