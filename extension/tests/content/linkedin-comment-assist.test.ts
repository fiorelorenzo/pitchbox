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
 * wiring, the ledger's own optional-project routing #521/#523) are covered
 * by later `describe` blocks below, using the real anonymised feed fixture
 * the same way.
 */

import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';
import FEED_HTML from './fixtures/linkedin/feed.html?raw';

const linkedinAssist = vi.fn();
const suggest = vi.fn();
const acceptSuggestion = vi.fn();
// #556: only reached from `setRefused`'s `billingLinkFor` branch (the two
// plan refusals) - every other test in this file never calls it, so a
// resolved default here changes nothing for them.
const pickPairing = vi.fn(async () => ({ backendUrl: 'https://app.pitchbox.app' }));

vi.mock('../../src/lib/api.js', () => ({
  api: {
    linkedinAssist: () => linkedinAssist(),
    suggest: (body: unknown, onEvent: unknown) => suggest(body, onEvent),
    acceptSuggestion: (body: unknown) => acceptSuggestion(body),
  },
  pickPairing: () => pickPairing(),
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

// #521/#523: an accepted suggestion files under `projectId` (the same value
// used to request it) or under no project at all - there is no separate
// "personal" project to route it to.
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
    const composer = document.querySelector<HTMLElement>(
      '[contenteditable="true"][role="textbox"]',
    );
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

    const mounted = logged.find((e) => e.message === 'activity.linkedin-action.assist-mounted') as
      { meta?: Record<string, unknown> } | undefined;
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
      data: { accepted: true, id: 4242, dedupWarning: null },
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
    // #521/#523: an accepted suggestion lands under `boundProjectId` (the
    // same value used to request it, projectId 2 above) - there is no
    // separate personal project to fall back to.
    expect(acceptSuggestion.mock.calls[0][0]).toMatchObject({ projectId: 2 });
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
      data: { accepted: true, id: 1, dedupWarning: null },
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

// #409: a retune regenerates the draft in an explicit direction, without
// leaving the panel and without writing the org's tone setting. Against the
// real panel component, same posture as every other describe block here:
// what the human sees is the whole feature.
describe('retune (#409): regenerate the draft in a direction, without leaving the panel', () => {
  it('drives resting to streaming to ready to retune to ready, with a different draft', async () => {
    const composer = renderPost();
    // Non-empty on purpose (#439): this is what keeps the panel at rest
    // until the human asks, rather than auto-requesting on mount.
    composer.textContent = 'I had already started writing this myself';
    suggest.mockImplementationOnce(streamingSuggest('First take.', 'Congrats on the launch.'));

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toContain('Suggest a comment');
    expect(suggest).not.toHaveBeenCalled();

    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(shadow().querySelector('textarea')?.value).toBe('Congrats on the launch.');

    suggest.mockImplementationOnce(
      streamingSuggest('Retuned take.', 'A drier version of the same point.'),
    );
    shadow().querySelector<HTMLButtonElement>('[data-retune="drier"]')!.click();
    await settle();

    // Ready again, but from a second, distinct model call carrying the
    // direction - not the same draft relabelled.
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(suggest.mock.calls[1][0]).toMatchObject({ retune: 'drier' });
    expect(shadow().querySelector('textarea')?.value).toBe('A drier version of the same point.');
  });

  it('asks before discarding a human edit, and never requests until confirmed', async () => {
    const composer = renderPost();
    suggest.mockImplementationOnce(streamingSuggest('', 'Original draft.'));
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const textarea = shadow().querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'My own edited words.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    shadow().querySelector<HTMLButtonElement>('[data-retune="shorter"]')!.click();
    await settle();

    // Still just the one call - retune has not fired, and the edit is still
    // on screen rather than silently replaced.
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(panelText()).toContain('This replaces what you edited.');
    expect(shadow().querySelector('textarea')?.value).toBe('My own edited words.');

    const cancel = [...shadow().querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Keep editing',
    );
    cancel!.click();
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(shadow().querySelector('textarea')?.value).toBe('My own edited words.');
    expect(panelText()).not.toContain('This replaces what you edited.');

    suggest.mockImplementationOnce(streamingSuggest('', 'Shorter version.'));
    shadow().querySelector<HTMLButtonElement>('[data-retune="shorter"]')!.click();
    await settle();
    const confirm = [...shadow().querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Retune anyway',
    );
    confirm!.click();
    await settle();

    expect(suggest).toHaveBeenCalledTimes(2);
    expect(suggest.mock.calls[1][0]).toMatchObject({ retune: 'shorter' });
    expect(shadow().querySelector('textarea')?.value).toBe('Shorter version.');
  });

  it('obeys the same refusal shapes a first request does', async () => {
    const composer = renderPost();
    suggest.mockImplementationOnce(streamingSuggest('', 'A draft.'));
    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    linkedinAssist.mockResolvedValue({
      ok: true,
      data: { assist: { ...ASSIST_ON.data.assist, enabled: false, killSwitch: true } },
    });
    shadow().querySelector<HTMLButtonElement>('[data-retune="warmer"]')!.click();
    await settle();

    expect(panelText()).toContain('An admin stopped the assistant.');
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
      'blocked',
      'backend_unreachable',
      'selector_health_degraded',
      // #556: the plan's own ceiling and a failed payment - distinct from
      // each other, so the panel can say which one stopped it.
      'plan_limit_reached',
      'plan_payment_required',
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

describe('a plan refusal explains itself and links to billing (#556)', () => {
  it('renders its own message for a spent suggestion limit, with a billing link', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'refused', reason: 'plan_limit_reached', detail: {} });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toMatch(/suggestion limit/i);
    const link = shadow().querySelector<HTMLAnchorElement>('.assist-link');
    expect(link?.getAttribute('href')).toBe('https://app.pitchbox.app/settings/billing');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('renders a distinct message for a failed payment, also with a billing link', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'refused', reason: 'plan_payment_required', detail: {} });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toMatch(/payment/i);
    expect(panelText()).not.toMatch(/suggestion limit/i);
    const link = shadow().querySelector<HTMLAnchorElement>('.assist-link');
    expect(link?.getAttribute('href')).toBe('https://app.pitchbox.app/settings/billing');
  });

  it('never links out for a refusal #556 did not name', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'refused', reason: 'assist_disabled', detail: {} });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(shadow().querySelector('.assist-link')).toBeNull();
  });
});

describe('the loop narrates its own steps (#573)', () => {
  it('names the tool it is running, collapses a parallel step into one line, and hands off to writing', async () => {
    const composer = renderPost();
    // Driven from out here, one `settle()` per event, rather than paced by
    // internal awaits inside the mock: the panel's own re-render only ever
    // needs one round trip to settle, and stacking several nested delays
    // inside a single `suggest()` call raced against the outer `settle()`
    // and left later events observed before they had actually rendered.
    let deliver: ((event: Record<string, unknown>) => void) | undefined;
    // extension/tsconfig.json targets a lib without `Promise.withResolvers`
    // (cli/src/lib/password.ts hit the same wall) - the executor form is
    // the one that typechecks here.
    let finish!: (value: { ok: true; data: { ok: true } }) => void;
    const suggestPromise = new Promise<{ ok: true; data: { ok: true } }>((resolve) => {
      finish = resolve;
    });
    suggest.mockImplementation((_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
      deliver = onEvent;
      return suggestPromise;
    });

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    deliver!({ kind: 'status', phase: 'read_thread' });
    await settle();
    expect(panelText()).toContain('Reading the thread…');

    // A parallel step collapses into one line naming the set, not two lines.
    deliver!({ kind: 'status', phase: 'read_thread,look_at_image' });
    await settle();
    expect(panelText()).toContain('Reading the thread and looking at the image…');

    deliver!({ kind: 'status', phase: 'my_prior_takes' });
    await settle();
    expect(panelText()).toContain('Checking your prior takes…');

    deliver!({ kind: 'status', phase: 'slow' });
    await settle();
    expect(panelText()).toContain('This is taking longer than usual.');

    deliver!({ kind: 'status', phase: 'writing' });
    await settle();
    expect(panelText()).toContain('Writing…');

    deliver!({ kind: 'chunk', text: 'A reply.', section: 'draft' });
    deliver!({ kind: 'done', reasoning: '', draft: 'A reply.', skipped: false, ms: 900 });
    finish({ ok: true, data: { ok: true } });
    await settle();
    expect(shadow().querySelector('textarea')?.value).toBe('A reply.');
  });

  it('never shows a raw tool name for a step this build does not recognise', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'status', phase: 'some_future_tool' });
        onEvent({ kind: 'chunk', text: 'A reply.', section: 'draft' });
        onEvent({ kind: 'done', reasoning: '', draft: 'A reply.', skipped: false, ms: 900 });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).not.toContain('some_future_tool');
  });

  it('says it answered with what it had once the hard budget cuts a draft short', async () => {
    const composer = renderPost();
    suggest.mockImplementation(
      async (_body: unknown, onEvent: (e: Record<string, unknown>) => void) => {
        onEvent({ kind: 'chunk', text: 'A reply.', section: 'draft' });
        onEvent({
          kind: 'done',
          reasoning: '',
          draft: 'A reply.',
          skipped: false,
          ms: 90_000,
          budgetExhausted: true,
        });
        return { ok: true as const, data: { ok: true } };
      },
    );

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(panelText()).toContain('Answered with what it had time to gather.');
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

describe('the visible thread (#568)', () => {
  /** A classic post-detail page with `count` synthetic comments, each
   * `bodyLength` characters long - same shape `findPostComments` reads
   * (`article[data-id^="urn:li:comment:"]`, `h3 span` for the byline,
   * `section` for the body, `time` for the relative-time text), reused
   * rather than invented, per the module's "reuse the existing accessors"
   * posture. */
  function renderThread(count: number, bodyLength: number): Element {
    const comments = Array.from(
      { length: count },
      (_, i) => `
        <article data-id="urn:li:comment:(activity:9999,${i})">
          <h3><span>Commenter ${i}</span></h3>
          <section>${'x'.repeat(bodyLength)}</section>
          <time>1h</time>
        </article>
      `,
    ).join('');
    document.body.innerHTML = `
      <div role="article" data-urn="urn:li:activity:9999">
        <div class="update-components-text">Hostile post body text, long enough to draft from.</div>
        ${comments}
      </div>
    `;
    const [post] = findFeedPosts(document);
    return post;
  }

  it('a hostile thread (many long comments) is clamped on every axis', () => {
    // 50 comments at 2000 chars each - past every one of the three caps
    // (30 comments, 500 chars/comment, 6000 chars total) at once.
    const post = renderThread(50, 2000);
    const captured = readAssistPostFromCard(post, document);
    const thread = captured?.thread;
    expect(thread).toBeDefined();
    // The page really did render 50 - this is LinkedIn's own count, before
    // any cap runs, and it must survive the clamp even though the comments
    // array carrying them does not.
    expect(thread!.renderedCount).toBe(50);
    expect(thread!.truncated).toBe(true);
    expect(thread!.comments.length).toBeLessThanOrEqual(30);
    for (const c of thread!.comments) expect(c.body.length).toBeLessThanOrEqual(500);
    const totalChars = thread!.comments.reduce((sum, c) => sum + c.body.length, 0);
    expect(totalChars).toBeLessThanOrEqual(6000);
  });

  it('many short comments hit the count cap on their own, well under the char caps', () => {
    // 50 comments at 50 chars each - 2500 chars total if every one made it
    // through, comfortably under the 6000-char cap, so only the 30-comment
    // count cap can be what stops this one.
    const post = renderThread(50, 50);
    const thread = readAssistPostFromCard(post, document)?.thread;
    expect(thread?.renderedCount).toBe(50);
    expect(thread?.comments).toHaveLength(30);
    expect(thread?.truncated).toBe(true);
  });

  it('a single oversized comment is clamped on its own, well under the count and total caps', () => {
    const post = renderThread(1, 2000);
    const thread = readAssistPostFromCard(post, document)?.thread;
    expect(thread?.renderedCount).toBe(1);
    expect(thread?.comments).toHaveLength(1);
    expect(thread?.comments[0]?.body.length).toBe(500);
    expect(thread?.truncated).toBe(true);
  });

  it('an ordinary thread under every cap is carried whole, marked not truncated', () => {
    const post = renderThread(3, 80);
    const thread = readAssistPostFromCard(post, document)?.thread;
    expect(thread?.renderedCount).toBe(3);
    expect(thread?.comments).toHaveLength(3);
    expect(thread?.truncated).toBe(false);
  });

  it('post-detail.html (real capture): the thread carries all 16 rendered comments, not truncated', () => {
    renderPost();
    const [post] = findFeedPosts(document);
    const thread = readAssistPostFromCard(post, document)?.thread;
    expect(thread?.renderedCount).toBe(16);
    expect(thread?.comments).toHaveLength(16);
    expect(thread?.truncated).toBe(false);
    expect(thread?.comments[0]?.authorName).toBe('Marco Rossi');
    expect(thread?.comments[0]?.parentId).toBeUndefined();
  });

  it('the suggest request carries the clamped thread, not the raw DOM read', async () => {
    const post = renderThread(50, 2000);
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.setAttribute('role', 'textbox');
    post.appendChild(composer);

    wireCommentAssist(composer, post);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    // vi.fn mock call built entirely by this test, not external input.
    const call = suggest.mock.calls[0][0] as {
      post: { thread?: { comments: Array<{ body: string }>; truncated: boolean } };
    };
    expect(call.post.thread?.truncated).toBe(true);
    expect(call.post.thread?.comments.length).toBeLessThanOrEqual(30);
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

describe('LOR-197: a comment permalink whose reply box opened under a comment', () => {
  /** A comment-permalink page shape reconstructed from the issue's own
   * report (a `/feed/update/urn:li:activity:.../?dashCommentUrn=...` page,
   * LinkedIn's own reply box open under one specific comment). No live
   * LinkedIn session was available to capture this page, so this is a
   * synthetic reconstruction, not an anonymised capture like
   * post-detail.html - same posture the #447 "unfamiliar feed variant"
   * fixture above takes. It carries no `[role="article"][data-urn]`/
   * `[role="listitem"]` on the card itself, so neither `findFeedPosts` nor
   * `resolveCardFor`'s known-role fallback can resolve it - only the
   * structural walk can, and only once it stops treating the reply box as
   * a second card's own composer.
   */
  function renderCommentPermalink(): { composer: HTMLElement; commentId: string } {
    const commentId = 'urn:li:comment:(activity:7000000000000000001,7000000000000000002)';
    document.body.innerHTML = `
      <div data-view-name="feed-full-update">
        <article>
          <div><a href="/in/marco-rossi/"><span aria-hidden="true">Marco Rossi</span></a></div>
          <div class="update-components-text">We shipped the new retry budget across every
          worker this week, and the false-positive throttling rate dropped by a factor
          nobody on the team expected going in. The part that actually mattered was not
          the algorithm change itself, it was watching which requests were the ones
          getting throttled.</div>
          <form><div contenteditable="true" role="textbox" aria-label="Aggiungi un commento"></div></form>
          <div>
            <article data-id="${commentId}">
              <h3><span>Giulia Bianchi</span></h3>
              <section>Which endpoints saw the biggest drop?</section>
              <form><div contenteditable="true" role="textbox" aria-label="Rispondi a Giulia Bianchi"></div></form>
            </article>
          </div>
        </article>
      </div>`;
    const composers = document.querySelectorAll<HTMLElement>(
      '[contenteditable="true"][role="textbox"]',
    );
    return { composer: composers[1], commentId };
  }

  it('resolves the post card through the reply box, where the old composer-count walk gave up, and names the post author as subject (LOR-198)', async () => {
    const { composer } = renderCommentPermalink();
    // No selector recognises this shape - only the structural walk can.
    expect(findFeedPosts(document)).toEqual([]);
    suggest.mockImplementation(
      streamingSuggest('Checked the dashboard for it.', 'The write path was the one that moved.'),
    );

    delegateComposerClicks();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(shadows().length).toBe(1);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(panelText()).not.toMatch(/layout changed/i);
    expect(shadow().querySelector('.subject')?.textContent).toBe('Marco Rossi');
  });

  it('names the parent comment id on the request, not just the post', async () => {
    const { composer, commentId } = renderCommentPermalink();
    suggest.mockImplementation(streamingSuggest('r', 'd'));

    delegateComposerClicks();
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    // vi.fn mock call built entirely by this test, not external input.
    const call = suggest.mock.calls[0][0] as { post: { replyToCommentId?: string } };
    expect(call.post.replyToCommentId).toBe(commentId);
  });

  it("the post's own composer on the same page carries no replyToCommentId", async () => {
    const { composer } = renderCommentPermalink();
    const mainComposer = document.querySelectorAll<HTMLElement>(
      '[contenteditable="true"][role="textbox"]',
    )[0];
    expect(mainComposer).not.toBe(composer);
    suggest.mockImplementation(streamingSuggest('r', 'd'));

    delegateComposerClicks();
    mainComposer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    const call = suggest.mock.calls[0][0] as { post: { replyToCommentId?: string } };
    expect(call.post.replyToCommentId).toBeUndefined();
  });
});

describe('LOR-197: a refusal from a page still loading recovers on retry', () => {
  it('re-reads the page on Try again instead of replaying the mount-time null capture', async () => {
    document.body.innerHTML = `
      <div role="article" data-urn="urn:li:activity:7000000000000000099">
        <div id="post-text"></div>
        <form><div contenteditable="true" role="textbox"></div></form>
      </div>`;
    const composer = document.querySelector<HTMLElement>(
      '[contenteditable="true"][role="textbox"]',
    )!;

    wireCommentAssist(composer);
    composer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(suggest).not.toHaveBeenCalled();
    const refusal = logged.find(
      (e) => e.message === 'activity.linkedin-action.suggestion-refused',
    ) as { meta?: Record<string, unknown> } | undefined;
    expect(refusal?.meta?.reason).toBe('selector_health_degraded');
    expect(shadow().querySelector('.assist-button')?.textContent?.trim()).toBe($tRetry());

    // The page finishes rendering: substantial post text arrives where
    // there was none at mount time.
    document.querySelector('#post-text')!.textContent =
      'We shipped the new retry budget across every worker this week, and the ' +
      'false-positive throttling rate dropped by a factor we did not expect going in.';
    suggest.mockImplementation(
      streamingSuggest('Because they measured it.', 'A real reply, once the text was there.'),
    );

    shadow().querySelector<HTMLButtonElement>('.assist-button')!.click();
    await settle();

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(shadow().querySelector('textarea')?.value).toBe(
      'A real reply, once the text was there.',
    );
  });
});

function $tRetry(): string {
  // Mirrors dict-en.ts's 'assist.action.retry' literally, so this test does
  // not have to import the whole i18n runtime just to name one button.
  return 'Try again';
}
