// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The in-page comment assist (#314), against the real Svelte panel rather than
 * a stand-in: what the human sees is the whole feature, and the panel's states
 * arrive through `panel-host`'s `update()`, which shipped as a silent no-op
 * until #369. So every assertion here reads the rendered shadow tree.
 *
 * The API layer is the only thing faked. The DOM is the real captured
 * post-detail fixture, the panel is the real component, and the composer the
 * text lands in is the fixture's own.
 *
 * #382's reasoning/draft split and the 2026-09-07 feed rework (per-card
 * wiring, `personalProjectId` routing) are covered by later `describe`
 * blocks below, using the real anonymised feed fixture the same way.
 */

import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';
import FEED_HTML from './fixtures/linkedin/feed.html?raw';

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

const {
  wireCommentAssist,
  refusalMessage,
  scanFeedForAssist,
  readAssistPostFromCard,
  delegateComposerClicks,
  composerHasOwnText,
} = await import('../../src/content/linkedin-comment-assist.js');
const { findFeedPosts } = await import('../../src/content/shared/linkedin-dom.js');

// `projectId` (context/grounding) and `personalProjectId` (decision 5: where
// an accepted draft is filed) are deliberately distinct values below, so a
// test that reads the wrong one fails loudly instead of passing by
// coincidence.
const ASSIST_ON = {
  ok: true as const,
  data: {
    assist: {
      enabled: true,
      collectorEnabled: true,
      killSwitch: false,
      projectId: 2,
      personalProjectId: 99,
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

/** Every mounted panel's shadow root, in DOM order - `shadow()` when there is
 * exactly one, `shadows()` when a test needs to tell two cards' panels apart. */
function shadows(): ShadowRoot[] {
  return [...document.querySelectorAll('*')].flatMap((e) => (e.shadowRoot ? [e.shadowRoot] : []));
}

function shadow(): ShadowRoot {
  const [first] = shadows();
  if (!first) throw new Error('no panel mounted');
  return first;
}

function textOf(root: ShadowRoot): string {
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function panelText(): string {
  return textOf(shadow());
}

/** Lets the panel's mount, the awaited API calls and Svelte's flush settle. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A suggestion delivered as the route delivers it (#382): reasoning chunks,
 * then draft chunks, then done. */
function streamingSuggest(reasoning: string, draft: string) {
  return async (_body: unknown, onEvent: (event: Record<string, unknown>) => void) => {
    onEvent({ kind: 'status', phase: 'writing' });
    if (reasoning) onEvent({ kind: 'chunk', text: reasoning, section: 'reasoning' });
    onEvent({ kind: 'chunk', text: draft.slice(0, 20), section: 'draft' });
    onEvent({ kind: 'chunk', text: draft.slice(20), section: 'draft' });
    onEvent({ kind: 'done', reasoning, draft, skipped: false, ms: 900 });
    return { ok: true as const, data: { ok: true } };
  };
}

// A content script always runs with a live `chrome.runtime` in the real
// isolated world, and since #438 the panel checks for one before requesting
// (a reloaded extension leaves open tabs unable to reach anything, and
// reporting that as an unreachable backend is a lie). jsdom has no `chrome`
// at all, so the tests have to supply the shape the browser guarantees.
const chromeStub = { runtime: { id: 'pitchbox-test-extension' } };

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
  chromeStub.runtime.id = 'pitchbox-test-extension';
  document.body.innerHTML = '';
  logged.length = 0;
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'FontFace');
  linkedinAssist.mockResolvedValue(ASSIST_ON);
});

// Whichever test runs last in this file leaves no `beforeEach` after it to
// trigger panel-host's own anchor-removal cleanup before jsdom tears down -
// without this, a mounted panel's leftover `MutationObserver` callback can
// fire once `window`/`document` are already gone. Clearing the DOM and
// settling after every test, not only before the next one, keeps that
// cleanup inside a still-live environment regardless of run order.
afterEach(async () => {
  document.body.innerHTML = '';
  await settle();
});

describe('one signal, not two clicks (#439)', () => {
  it('mounts nothing until the human clicks into the composer', async () => {
    const composer = renderPost();
    wireCommentAssist(composer);
    await settle();

    expect([...document.querySelectorAll('*')].some((e) => e.shadowRoot)).toBe(false);
    expect(linkedinAssist).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('starts the request on that same click, with no second control to press', async () => {
    const composer = renderPost();
    suggest.mockImplementation(streamingSuggest('Because it is specific.', 'A real comment.'));
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toContain('Giulia Bianchi');
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(shadow().querySelector('textarea')?.value).toBe('A real comment.');
  });

  it('waits to be asked when the composer already holds the human own text', async () => {
    const composer = renderPost();
    composer.textContent = 'I had already started writing this myself';
    suggest.mockImplementation(streamingSuggest('r', 'd'));
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).not.toHaveBeenCalled();
    expect(shadows().length).toBe(1);
  });

  it('reopening a card it already answered costs no second model call', async () => {
    const composer = renderPost();
    suggest.mockImplementation(streamingSuggest('Because it is specific.', 'A real comment.'));
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(suggest).toHaveBeenCalledTimes(1);

    // The human dismisses the panel, then clicks the same composer again.
    const dismiss = [...shadow().querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? '').length > 0,
    );
    dismiss?.click();
    await settle();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(shadow().querySelector('textarea')?.value).toBe('A real comment.');
  });

  it('says the extension was reloaded rather than blaming the backend (#438)', async () => {
    const composer = renderPost();
    suggest.mockImplementation(streamingSuggest('r', 'd'));
    // What a content script sees after its extension is reloaded under it:
    // the context is dead, every request fails against
    // `chrome-extension://invalid/`, and the backend is perfectly fine.
    Reflect.deleteProperty(chromeStub.runtime, 'id');

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).not.toHaveBeenCalled();
    expect(linkedinAssist).not.toHaveBeenCalled();
    expect(panelText()).toContain('reload this page');
    expect(panelText()).not.toContain('Could not reach');
  });

  it('mounts one panel per anchor however many times the human clicks', async () => {
    const composer = renderPost();
    wireCommentAssist(composer);
    for (let i = 0; i < 3; i++) composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
  });
});

describe('the panel mounts from the click, not from a card selector (#447)', () => {
  // What Lorenzo's activity export showed: the scripts running on a
  // `feed-sdui` page, `findFeedPosts` recognising nothing, and the panel
  // never mounting - with no diagnostic, because the only one that existed
  // fires on the classic post-detail page. Delegation is what makes the
  // feature independent of that recognition.
  function renderUnknownFeedVariant(): HTMLElement {
    document.body.innerHTML = `
      <main>
        <div class="_someHashedClass">
          <span>Davide Mastricci</span>
          <div>We shipped the retry budget this week and the p99 halved. The interesting
          part was not the cache, it was realising the budget was being spent on requests
          nobody was waiting for.</div>
          <form>
            <div contenteditable="true" role="textbox" aria-label="Aggiungi un commento"></div>
          </form>
        </div>
      </main>`;
    const composer = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
    if (!composer) throw new Error('no composer in the fixture');
    return composer;
  }

  it('mounts and requests on a feed variant no card selector recognises', async () => {
    const composer = renderUnknownFeedVariant();
    expect(findFeedPosts(document)).toEqual([]);
    suggest.mockImplementation(streamingSuggest('Because they measured it.', 'A real reply.'));

    delegateComposerClicks();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(shadows().length).toBe(1);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(shadow().querySelector('textarea')?.value).toBe('A real reply.');
  });

  it('logs what it mounted on, so silence is never the whole report', async () => {
    const composer = renderUnknownFeedVariant();
    suggest.mockImplementation(streamingSuggest('r', 'd'));

    delegateComposerClicks();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const mounted = logged.find(
      (e) => e.message === 'activity.linkedin-action.assist-mounted',
    ) as { meta?: Record<string, unknown> } | undefined;
    expect(mounted).toBeTruthy();
    // The structural fallback resolved a card even though no selector did.
    expect(mounted!.meta).toMatchObject({ cardResolved: true, composerHadOwnText: false });
  });

  it('ignores a click in the post composer modal, which has its own panel', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div contenteditable="true" role="textbox"></div>
      </div>`;
    const composer = document.querySelector<HTMLElement>('[contenteditable="true"]')!;

    delegateComposerClicks();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(shadows().length).toBe(0);
    expect(suggest).not.toHaveBeenCalled();
  });

  it('mounts one panel however the click arrives, delegated or wired', async () => {
    const composer = renderPost();
    suggest.mockImplementation(streamingSuggest('r', 'd'));

    delegateComposerClicks();
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
    expect(suggest).toHaveBeenCalledTimes(1);
  });
});

describe('an empty rich-text editor is empty (#447)', () => {
  function editor(inner: string): HTMLElement {
    document.body.innerHTML = `<div contenteditable="true" role="textbox">${inner}</div>`;
    return document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  }

  it('reads LinkedIn own empty states as empty', () => {
    expect(composerHasOwnText(editor('<p><br></p>'))).toBe(false);
    expect(composerHasOwnText(editor('\u200b'))).toBe(false);
    expect(composerHasOwnText(editor('&nbsp;'))).toBe(false);
    expect(
      composerHasOwnText(editor('<span aria-hidden="true">Aggiungi un commento...</span>')),
    ).toBe(false);
    expect(composerHasOwnText(editor('<div data-placeholder="Add a comment"></div>'))).toBe(false);
    expect(composerHasOwnText(editor('<span class="ql-placeholder">Add a comment</span>'))).toBe(
      false,
    );
  });

  it('still reads a half-written comment as the human own text', () => {
    expect(composerHasOwnText(editor('<p>I was already writing this</p>'))).toBe(true);
  });

  it('does not leave the panel waiting on a placeholder-only composer', async () => {
    const composer = renderPost();
    composer.innerHTML = '<span aria-hidden="true">Aggiungi un commento...</span>';
    suggest.mockImplementation(streamingSuggest('r', 'd'));

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
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
      ): Promise<{ ok: true; data: { ok: true } }> => {
        onEvent({ kind: 'status', phase: 'writing' });
        onEvent({ kind: 'chunk', text: 'First half. ', section: 'draft' });
        await settle(2);
        seen.push(panelText());
        onEvent({ kind: 'chunk', text: 'Second half.', section: 'draft' });
        onEvent({
          kind: 'done',
          reasoning: '',
          draft: 'First half. Second half.',
          skipped: false,
          ms: 900,
        });
        return { ok: true, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    // Mid-stream the panel already showed the first chunk and nothing of the second.
    expect(seen[0]).toContain('First half.');
    expect(seen[0]).not.toContain('Second half.');
    // And when it finishes, the human gets an editable copy of the whole thing.
    expect(shadow().querySelector('textarea')?.value).toBe('First half. Second half.');
  });

  it('shows the reasoning while it waits, then folds it under the draft (D17)', async () => {
    const composer = renderPost();
    const seen: string[] = [];
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'status', phase: 'writing' });
        onEvent({ kind: 'chunk', text: 'Friendly, technical tone.', section: 'reasoning' });
        await settle(2);
        // Mid-stream: the reasoning is the only thing there is to read.
        seen.push(panelText());
        onEvent({ kind: 'chunk', text: 'Nice writeup!', section: 'draft' });
        onEvent({
          kind: 'done',
          reasoning: 'Friendly, technical tone.',
          draft: 'Nice writeup!',
          skipped: false,
          ms: 900,
        });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(seen[0]).toContain('Friendly, technical tone.');

    // Once the draft exists it is the draft that is on screen, and the
    // reasoning is one collapsed line, not a paragraph above it.
    const draftEl = shadow().querySelector('textarea');
    expect(draftEl?.value).toBe('Nice writeup!');
    expect(panelText()).not.toContain('Friendly, technical tone.');

    const why = shadow().querySelector<HTMLButtonElement>('.assist-why');
    expect(why).toBeTruthy();
    expect(why!.getAttribute('aria-expanded')).toBe('false');
    // The disclosure sits after the draft, not before it.
    expect(draftEl!.compareDocumentPosition(why!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    why!.click();
    await settle();
    expect(shadow().querySelector('.assist-why-body')?.textContent).toBe(
      'Friendly, technical tone.',
    );
    expect(why!.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps an open disclosure open while the human edits the draft', async () => {
    const composer = renderPost();
    suggest.mockImplementation(streamingSuggest('Because it answers their question.', 'A reply.'));

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-why')!.click();
    await settle();

    const textarea = shadow().querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'A reply, edited by hand.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    expect(shadow().querySelector('.assist-why-body')?.textContent).toBe(
      'Because it answers their question.',
    );
  });
});

describe('accept, insert, and the button the human presses', () => {
  it('writes the text into LinkedIn own composer and dispatches no click or submit', async () => {
    const composer = renderPost();
    const text = 'We saw the same thing, but the cause was PR size.';
    suggest.mockImplementation(streamingSuggest('', text));
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
    } finally {
      HTMLElement.prototype.click = realClick;
    }

    expect(composer.textContent).toContain('PR size');
    expect(acceptSuggestion).toHaveBeenCalledTimes(1);
    // Decision 5: an accepted draft lands under the personal project, not
    // the project the suggestion was grounded in.
    expect(acceptSuggestion.mock.calls[0][0]).toMatchObject({ projectId: 99 });
    expect(clicks).toEqual([]);
    expect(submits).toEqual([]);
    expect(panelText()).toMatch(/Comment button|Inserted/i);
  });

  it('sends only the draft on accept, never the reasoning', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      streamingSuggest('This reasoning must never reach LinkedIn.', 'A clean, short reply.'),
    );
    acceptSuggestion.mockResolvedValue({
      ok: true,
      data: { accepted: true, draftId: 1, runId: 1 },
    });

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(acceptSuggestion.mock.calls[0][0].body).toBe('A clean, short reply.');
    expect(composer.textContent).toContain('A clean, short reply.');
    expect(composer.textContent).not.toContain('This reasoning must never reach LinkedIn.');
  });
});

describe('no draft: #382, the fail-safe is "no marker means no draft"', () => {
  it('a decline says so in the product own words, with the model reasoning folded away (D18)', async () => {
    const composer = renderPost();
    const modelProse = 'This post is a job posting; commenting reads as spam here.';
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'status', phase: 'writing' });
        onEvent({
          kind: 'done',
          reasoning: modelProse,
          draft: null,
          skipped: true,
          ms: 400,
        });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    // The state is named by the product, in a title of its own; the model's
    // prose is not the copy the human is handed.
    const title = shadow().querySelector('.assist-title');
    // The literal, not the key: the point of D18 is that the human reads
    // the product's sentence, so the sentence is what the test names.
    expect(title?.textContent?.trim()).toBe('No suggestion for this post');
    expect(panelText()).not.toContain(modelProse);
    // Nothing to insert, and one way forward.
    expect(panelText()).not.toContain('Insert');
    expect(shadow().querySelector('textarea')).toBeNull();
    expect(shadow().querySelectorAll('.assist-button').length).toBe(1);
    expect(shadow().querySelector('.assist-button')?.textContent?.trim()).toBe($tRetry());
    // The reasoning is still reachable, on purpose: the decision is the
    // feature, so it is available rather than hidden.
    shadow().querySelector<HTMLButtonElement>('.assist-why')!.click();
    await settle();
    expect(shadow().querySelector('.assist-why-body')?.textContent).toBe(modelProse);
  });

  it('a malformed answer (not skipped) renders distinct copy from a decline, still no insert control', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'status', phase: 'writing' });
        onEvent({
          kind: 'done',
          reasoning: 'Thinking about tone...',
          draft: null,
          skipped: false,
          ms: 400,
        });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const skippedCopy = panelText();

    document.body.innerHTML = '';
    const second = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({
          kind: 'done',
          reasoning: 'Thinking about tone...',
          draft: null,
          skipped: true,
          ms: 400,
        });
        return { ok: true as const, data: { ok: true } };
      },
    );
    wireCommentAssist(second);
    second.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).not.toBe(skippedCopy);
    expect(shadow().querySelector('textarea')).toBeNull();
  });

  it('logs the no-draft outcome, distinct from a refusal', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({
          kind: 'done',
          reasoning: 'Nothing to add.',
          draft: null,
          skipped: true,
          ms: 400,
        });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const entry = logged.find((e) => e.message === 'activity.linkedin-action.suggestion-no-draft');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe('info');
    expect(logged.some((e) => e.message === 'activity.linkedin-action.suggestion-refused')).toBe(
      false,
    );
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

describe('per-card wiring on the feed (2026-09-07 overlay/feed rework)', () => {
  /** Appends a synthetic comment composer under `card` - the real anonymised
   * fixture carries none (LinkedIn renders one lazily, behind the human's
   * own "Comment" click, only after this content script would already be
   * running), so this stands in for that click's own DOM effect. Never a
   * simulated click on a LinkedIn control - the composer element itself is
   * the only thing added. */
  function appendComposer(card: Element): HTMLElement {
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.setAttribute('role', 'textbox');
    card.appendChild(composer);
    return composer;
  }

  /** The fixture's real cards carry mostly empty commentary in this reduced
   * capture; this appends the one element `readPostText` actually reads
   * (`[data-sdui-anchor-id^="commentary-"]`), giving each card real text to
   * draft from without touching any selector this module depends on. */
  function appendCommentary(card: Element, text: string): void {
    const el = document.createElement('p');
    el.setAttribute('data-sdui-anchor-id', 'commentary-test');
    el.textContent = text;
    card.appendChild(el);
  }

  function renderFeed(): Element[] {
    document.body.innerHTML = FEED_HTML;
    return findFeedPosts(document);
  }

  it('wires two cards to two independent panels, each keyed to its own post', async () => {
    const cards = renderFeed();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    appendCommentary(cards[0], 'First card body text, long enough to draft from.');
    appendCommentary(cards[1], 'Second card body text, long enough to draft from.');

    scanFeedForAssist(document);
    const composerA = appendComposer(cards[0]);
    const composerB = appendComposer(cards[1]);
    await settle();

    composerA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    composerB.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(2);

    const postA = readAssistPostFromCard(cards[0], document);
    const postB = readAssistPostFromCard(cards[1], document);
    expect(postA?.authorName).toBeTruthy();
    expect(postB?.authorName).toBeTruthy();
    expect(postA?.authorName).not.toBe(postB?.authorName);
  });

  it("the second card's suggestion request carries the second card's own author, not the first's", async () => {
    const cards = renderFeed();
    appendCommentary(cards[0], 'First card body text, long enough to draft from.');
    appendCommentary(cards[1], 'Second card body text, long enough to draft from.');
    const expectedAuthor = readAssistPostFromCard(cards[1], document)?.authorName;
    expect(expectedAuthor).toBeTruthy();

    scanFeedForAssist(document);
    const composerA = appendComposer(cards[0]);
    const composerB = appendComposer(cards[1]);
    await settle();

    composerA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    composerB.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    // The second card's own panel names its own author as the subject, not
    // whichever author the first card's panel already showed.
    const [, panelB] = shadows();
    expect(textOf(panelB)).toContain(expectedAuthor!);
  });

  it('a feed suggestion carries no urn, but does carry the author handle', async () => {
    const cards = renderFeed();
    appendCommentary(cards[0], 'Enough body text on the feed card to draft a reply from.');
    const post = readAssistPostFromCard(cards[0], document);
    expect(post?.urn).toBeUndefined();
    expect(post?.authorHandle).toBeTruthy();

    scanFeedForAssist(document);
    const composer = appendComposer(cards[0]);
    await settle();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    // vi.fn mock call built entirely by this test, not external input.
    const call = suggest.mock.calls[0][0] as { post: { urn?: string; authorHandle?: string } };
    const sentPost = call.post;
    expect(sentPost.urn).toBeUndefined();
    expect(sentPost.authorHandle).toBe(post?.authorHandle);
  });

  it('re-running the scan does not double-wire an already-wired card', async () => {
    const cards = renderFeed();
    appendCommentary(cards[0], 'Enough body text on the feed card to draft a reply from.');

    scanFeedForAssist(document);
    scanFeedForAssist(document); // mirrors the MutationObserver firing again
    const composer = appendComposer(cards[0]);
    await settle();

    let clickListenerCalls = 0;
    const realAdd = HTMLElement.prototype.addEventListener;
    // wireCommentAssist attaches exactly one click listener per composer; a
    // double-wire would attach a second one here, on the very same element.
    composer.addEventListener = function patched(
      this: HTMLElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === 'click') clickListenerCalls++;
      // @ts-expect-error - forwarding a variadic spy to the real implementation
      return realAdd.call(this, type, ...rest);
    };

    scanFeedForAssist(document); // composer already exists now; still a no-op
    await settle();

    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('pitchbox-panel-host').length).toBe(1);
    expect(clickListenerCalls).toBe(0);
  });
});

function $tRetry(): string {
  // Mirrors dict-en.ts's 'assist.action.retry' literally, so this test does
  // not have to import the whole i18n runtime just to name one button.
  return 'Try again';
}
