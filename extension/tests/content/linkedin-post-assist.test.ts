// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The in-page post composer assist (#315), against the real Svelte panel
 * rather than a stand-in - same posture `linkedin-comment-assist.test.ts`
 * takes for #314, for the same reason.
 *
 * Unlike the comment assist, no captured fixture shows LinkedIn's "Start a
 * post" modal open (see `linkedin-post-assist.ts`'s own module doc comment
 * and `linkedin-dom.ts`'s header) - so the DOM here is synthetic, matching
 * the same posture `linkedin-dom.test.ts`'s own synthetic cases already take
 * for `findPostComposer`/`findMessageEvents`. The API layer is faked; the
 * panel and the modal shape are real.
 */

const linkedinAssist = vi.fn();
const suggest = vi.fn();
const acceptSuggestion = vi.fn();
const armed = vi.fn(async (_draftId: number, _backendUrl?: string) => ({
  ok: true as const,
  data: {},
}));

vi.mock('../../src/lib/api.js', () => ({
  api: {
    linkedinAssist: () => linkedinAssist(),
    suggest: (body: unknown, onEvent: unknown) => suggest(body, onEvent),
    acceptSuggestion: (body: unknown) => acceptSuggestion(body),
    armed: (draftId: number, backendUrl?: string) => armed(draftId, backendUrl),
  },
}));

const logged: Array<Record<string, unknown>> = [];
vi.mock('../../src/lib/log-from-content.js', () => ({
  logFromContent: (entry: Record<string, unknown>) => {
    logged.push(entry);
  },
}));

// Dynamic, not static: this module must load after the `vi.mock` calls
// above are in place (vitest hoists `vi.mock` but not a static import),
// matching `linkedin-comment-assist.test.ts`'s own established pattern.
const { wirePostAssist, wirePostSubmit, refusalMessage } = await import(
  '../../src/content/linkedin-post-assist.js'
);

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
 * LinkedIn's "Start a post" modal, in the minimal shape
 * `findPostComposerModal`/`findPostComposer` read: a `role="dialog"`
 * container wrapping the same `contenteditable`/`role="textbox"` editor the
 * comment composer uses. Synthetic, not a capture - see this file's own doc
 * comment.
 */
function renderModal(): { modal: HTMLElement; editor: HTMLElement } {
  document.body.innerHTML =
    '<div role="dialog"><div contenteditable="true" role="textbox"></div></div>';
  const modal = document.querySelector<HTMLElement>('[role="dialog"]');
  const editor = modal?.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
  if (!modal || !editor) throw new Error('synthetic modal build failed');
  return { modal, editor };
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
  it('mounts nothing until the human clicks into the post editor', async () => {
    const { editor, modal } = renderModal();
    wirePostAssist(editor, modal);
    await settle();

    expect([...document.querySelectorAll('*')].some((e) => e.shadowRoot)).toBe(false);
    expect(linkedinAssist).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('mounts on the click, and still asks for nothing until the human asks', async () => {
    const { editor, modal } = renderModal();
    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toContain('Suggest a post');
    expect(suggest).not.toHaveBeenCalled();
  });

  it('mounts one panel per anchor however many times the human clicks', async () => {
    const { editor, modal } = renderModal();
    wirePostAssist(editor, modal);
    for (let i = 0; i < 3; i++) editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
  });
});

describe('grounded through the server, never a pile of observed posts', () => {
  it('asks for kind "post" and sends only the current page URL, never post text this script read itself', async () => {
    const { editor, modal } = renderModal();
    suggest.mockImplementation(streamingSuggest('A short update about tonight.'));

    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    const [body] = suggest.mock.calls[0] as [Record<string, unknown>];
    expect(body.kind).toBe('post');
    expect(body.post).toEqual({ url: location.href });
  });
});

describe('the suggestion, as it arrives', () => {
  it('renders partial text while the stream is still open, not just at the end', async () => {
    const { editor, modal } = renderModal();
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

    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(seen[0]).toContain('First half.');
    expect(seen[0]).not.toContain('Second half.');
    expect(shadow().querySelector('textarea')?.value).toBe('First half. Second half.');
  });
});

describe('accept, insert, and the button the human presses', () => {
  it('writes the text into LinkedIn own composer and dispatches no click or submit', async () => {
    const { editor, modal } = renderModal();
    const text = 'Shipped the post composer assist tonight.';
    suggest.mockImplementation(streamingSuggest(text));
    acceptSuggestion.mockResolvedValue({
      ok: true,
      data: { accepted: true, draftId: 5150, runId: 9 },
    });

    const clicks: string[] = [];
    const submits: string[] = [];
    const realClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function patched(this: HTMLElement) {
      // The panel's own controls are the human's clicks in this test; what the
      // boundary forbids is a click on LinkedIn's own submit control.
      if (!this.closest('pitchbox-panel-host') && !this.getRootNode().toString().includes('Shadow'))
        clicks.push(this.tagName);
      return realClick.call(this);
    };
    document.addEventListener('submit', (e) => submits.push(String(e.type)), true);

    try {
      wirePostAssist(editor, modal);
      editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
      await settle();
      shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
      await settle();
    } finally {
      HTMLElement.prototype.click = realClick;
    }

    expect(editor.textContent).toContain('post composer assist');
    expect(acceptSuggestion).toHaveBeenCalledTimes(1);
    // No urn/authorHandle/authorName in the accept body: a post has none of
    // those until it publishes, and it is the operator's own voice.
    expect(acceptSuggestion.mock.calls[0][0]).toMatchObject({ kind: 'post', post: {} });
    expect(clicks).toEqual([]);
    expect(submits).toEqual([]);
    expect(panelText()).toMatch(/Post button|Inserted/i);
  });
});

describe('every refusal says which one it is', () => {
  it("gives the post quota message its own key, distinct from the comment assist's own", () => {
    expect(refusalMessage('quota_exhausted').key).toBe('assist.refusal.post_quota_exhausted');
  });

  it('maps every other known reason to its own distinct message key', () => {
    const keys = [
      'assist_disabled',
      'kill_switch',
      'project_not_bound',
      'no_recent_activity',
      'no_account',
      'blocked',
      'backend_unreachable',
      'generation_failed',
    ].map((reason) => refusalMessage(reason).key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(refusalMessage('a_reason_nobody_has_written_yet').key).toBe('assist.refusal.unknown');
  });
});

describe('refusal rendering: post-specific, not the comment assist copy', () => {
  it('renders the post quota message, not the comment quota message, when the server refuses quota_exhausted', async () => {
    const { editor, modal } = renderModal();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'refused', reason: 'quota_exhausted', detail: {} });
        return { ok: true, data: {} };
      },
    );

    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(panelText()).toMatch(/post quota/i);
    expect(panelText()).not.toMatch(/comment/i);
  });

  it('renders a distinct message when the observation buffer has nothing recent to ground a post in', async () => {
    const { editor, modal } = renderModal();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'refused', reason: 'no_recent_activity', detail: {} });
        return { ok: true, data: {} };
      },
    );

    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(panelText()).toMatch(/nothing recent/i);
  });
});

describe('single-page navigation', () => {
  it('leaves no panel behind when LinkedIn tears the modal down', async () => {
    const { editor, modal } = renderModal();
    wirePostAssist(editor, modal);
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);

    document.body.innerHTML = '';
    await new Promise((r) => setTimeout(r, 10));

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(0);
  });
});

describe('post completion detection: arms, but never fabricates a sent confirmation', () => {
  // No fixture shows a published post's URN anywhere (see the module doc
  // comment's "No URN after publish" section) - so `wirePostSubmit` is
  // exercised directly against synthetic markup, matching every other
  // unverified accessor's own test posture in this repo.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildArmedModal(): { modal: HTMLElement; btn: HTMLButtonElement } {
    document.body.innerHTML =
      '<div role="dialog"><div contenteditable="true" role="textbox">draft</div>' +
      '<button type="submit">Pubblica</button></div>';
    const modal = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const btn = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    return { modal, btn };
  }

  it('arms the draft on the human click - never dispatched, only listened for', async () => {
    const { modal, btn } = buildArmedModal();
    expect(wirePostSubmit(modal, 777)).toBe(true);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(armed).toHaveBeenCalledWith(777, undefined);
  });

  it('logs a distinct warning, and never a fabricated sent, once the modal closes without an error', async () => {
    const { modal, btn } = buildArmedModal();
    wirePostSubmit(modal, 777);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // LinkedIn's own signal a submit went through, on the SDUI frontend a
    // freshly published post exposes no other identifier this module could
    // read instead (see the module doc comment).
    document.body.innerHTML = '';
    await vi.advanceTimersByTimeAsync(600);

    const warn = logged.find(
      (e) => e.message === 'activity.linkedin-action.post-confirm-unavailable',
    );
    expect(warn).toBeDefined();
    expect(warn?.level).toBe('warn');
    expect(warn?.messageParams).toEqual({ draftId: 777 });
  });

  it('leaves the draft armed and logs nothing when the modal closes but LinkedIn shows an inline error', async () => {
    const { modal, btn } = buildArmedModal();
    wirePostSubmit(modal, 777);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // The modal is gone - the same shape a successful submit leaves - but
    // LinkedIn also rendered an inline error, a failed submit's real shape.
    // The error must win: "the modal closed" alone is not enough to log
    // anything, and it must never be read as a confirmation.
    document.body.innerHTML = '';
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'Something went wrong. Please try again.';
    document.body.appendChild(alert);
    await vi.advanceTimersByTimeAsync(600);

    expect(
      logged.some((e) => String(e.message).startsWith('activity.linkedin-action.post-confirm')),
    ).toBe(false);
  });

  it('gives up and logs a distinct timeout when the modal neither closes nor errors within 20s', async () => {
    const { modal, btn } = buildArmedModal();
    wirePostSubmit(modal, 777);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(20_000);

    const warn = logged.find((e) => e.message === 'activity.linkedin-action.post-confirm-timeout');
    expect(warn).toBeDefined();
    expect(warn?.messageParams).toEqual({ draftId: 777 });
  });
});
