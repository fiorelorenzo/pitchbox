// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The in-page comment assist (#314), against the real Svelte panel rather than
 * a stand-in: what the human sees is the whole feature, and the panel's states
 * arrive through `panel-host`'s `update()`, which shipped as a silent no-op
 * until #369. So every assertion here reads the rendered shadow tree.
 *
 * The API layer is the only thing faked. The DOM is the real captured
 * post-detail fixture, the panel is the real component, and the composer the
 * text lands in is the fixture's own.
 */

import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';

const linkedinAssist = vi.fn();
const suggest = vi.fn();
const acceptSuggestion = vi.fn();
const armed = vi.fn(async () => ({ ok: true as const, data: {} }));
const sent = vi.fn(async () => ({ ok: true as const, data: {} }));

vi.mock('../../src/lib/api.js', () => ({
  api: {
    linkedinAssist: () => linkedinAssist(),
    suggest: (body: unknown, onEvent: unknown) => suggest(body, onEvent),
    acceptSuggestion: (body: unknown) => acceptSuggestion(body),
    armed: () => armed(),
    sent: () => sent(),
  },
}));

const logged: Array<Record<string, unknown>> = [];
vi.mock('../../src/lib/log-from-content.js', () => ({
  logFromContent: (entry: Record<string, unknown>) => {
    logged.push(entry);
  },
}));

const { wireCommentAssist, refusalMessage } =
  await import('../../src/content/linkedin-comment-assist.js');

const ASSIST_ON = {
  ok: true as const,
  data: {
    assist: {
      enabled: true,
      collectorEnabled: true,
      killSwitch: false,
      projectId: 2,
      dailyCommentCap: 8,
      dailyPostCap: 1,
    },
  },
};

/**
 * The shape the fixture's classic post-detail page has, reduced to what the
 * selector module reads: an activity URN, an author link, the post text, and a
 * contenteditable comment composer.
 */
function renderPost(): HTMLElement {
  // The real captured page, not hand-written markup: the selectors this feature
  // depends on are the reason the fixture exists (see its README).
  document.body.innerHTML = POST_DETAIL_HTML;
  const composer = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
  if (!composer) throw new Error('fixture has no comment composer');
  return composer;
}

function shadow(): ShadowRoot {
  const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
  if (!host?.shadowRoot) throw new Error('no panel mounted');
  return host.shadowRoot;
}

function panelText(): string {
  return (shadow().textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Lets the panel's mount, the awaited API calls and Svelte's flush settle. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A suggestion delivered as the route delivers it: chunks, then done. */
function streamingSuggest(text: string) {
  return async (_body: unknown, onEvent: (event: Record<string, unknown>) => void) => {
    onEvent({ kind: 'status', phase: 'writing' });
    onEvent({ kind: 'chunk', text: text.slice(0, 20) });
    onEvent({ kind: 'chunk', text: text.slice(20) });
    onEvent({ kind: 'done', text, ms: 900 });
    return { ok: true as const, data: { text } };
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  logged.length = 0;
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'FontFace');
  linkedinAssist.mockResolvedValue(ASSIST_ON);
});

describe('the panel never appears unprompted', () => {
  it('mounts nothing until the human clicks into the composer', async () => {
    const composer = renderPost();
    wireCommentAssist(composer);
    await settle();

    expect([...document.querySelectorAll('*')].some((e) => e.shadowRoot)).toBe(false);
    expect(linkedinAssist).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('mounts on the click, and still asks for nothing until the human asks', async () => {
    const composer = renderPost();
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toContain('Giulia Bianchi');
    expect(suggest).not.toHaveBeenCalled();
  });

  it('mounts one panel per anchor however many times the human clicks', async () => {
    const composer = renderPost();
    wireCommentAssist(composer);
    for (let i = 0; i < 3; i++) composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
  });
});

describe('the suggestion, as it arrives', () => {
  it('renders partial text while the stream is still open, not just at the end', async () => {
    const composer = renderPost();
    const seen: string[] = [];
    suggest.mockImplementation(
      async (
        _body: unknown,
        onEvent: (e: Record<string, unknown>) => void,
      ): Promise<{ ok: true; data: { text: string } }> => {
        onEvent({ kind: 'status', phase: 'writing' });
        onEvent({ kind: 'chunk', text: 'First half. ' });
        await settle(2);
        seen.push(panelText());
        onEvent({ kind: 'chunk', text: 'Second half.' });
        onEvent({ kind: 'done', text: 'First half. Second half.', ms: 900 });
        return { ok: true, data: { text: 'First half. Second half.' } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    // Mid-stream the panel already showed the first chunk and nothing of the second.
    expect(seen[0]).toContain('First half.');
    expect(seen[0]).not.toContain('Second half.');
    // And when it finishes, the human gets an editable copy of the whole thing.
    expect(shadow().querySelector('textarea')?.value).toBe('First half. Second half.');
  });
});

describe('accept, insert, and the button the human presses', () => {
  it('writes the text into LinkedIn own composer and dispatches no click or submit', async () => {
    const composer = renderPost();
    const text = 'We saw the same thing, but the cause was PR size.';
    suggest.mockImplementation(streamingSuggest(text));
    acceptSuggestion.mockResolvedValue({
      ok: true,
      data: { accepted: true, draftId: 4242, runId: 7 },
    });

    const clicks: string[] = [];
    const submits: string[] = [];
    const realClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function patched(this: HTMLElement) {
      // The panel's own controls are the human's clicks in this test; what the
      // boundary forbids is a click on LinkedIn's send control.
      if (!this.closest('pitchbox-panel-host') && !this.getRootNode().toString().includes('Shadow'))
        clicks.push(this.tagName);
      return realClick.call(this);
    };
    document.addEventListener('submit', (e) => submits.push(String(e.type)), true);

    try {
      wireCommentAssist(composer);
      composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
      await settle();
      shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
      await settle();
    } finally {
      HTMLElement.prototype.click = realClick;
    }

    expect(composer.textContent).toContain('PR size');
    expect(acceptSuggestion).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual([]);
    expect(submits).toEqual([]);
    expect(panelText()).toMatch(/Comment button|Inserted/i);
  });
});

describe('every refusal says which one it is', () => {
  it('maps each server reason to its own message key', () => {
    const keys = [
      'assist_disabled',
      'kill_switch',
      'project_not_bound',
      'quota_exhausted',
      'backend_unreachable',
      'selector_health_degraded',
    ].map((reason) => refusalMessage(reason).key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(refusalMessage('a_reason_nobody_has_written_yet').key).toBe('assist.refusal.unknown');
  });

  it('renders the kill switch distinctly from never having been turned on', async () => {
    const composer = renderPost();
    linkedinAssist.mockResolvedValue({
      ok: true,
      data: { assist: { ...ASSIST_ON.data.assist, enabled: false, killSwitch: true } },
    });

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    const killed = panelText();
    expect(suggest).not.toHaveBeenCalled();

    document.body.innerHTML = '';
    const second = renderPost();
    linkedinAssist.mockResolvedValue({
      ok: true,
      data: { assist: { ...ASSIST_ON.data.assist, enabled: false, killSwitch: false } },
    });
    wireCommentAssist(second);
    second.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(panelText()).not.toBe(killed);
  });
});

describe('single-page navigation', () => {
  it('leaves no panel behind when LinkedIn replaces the post node', async () => {
    const composer = renderPost();
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);

    document.body.innerHTML = '';
    await new Promise((r) => setTimeout(r, 10));

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(0);
  });
});
