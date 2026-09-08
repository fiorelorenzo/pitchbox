// MUST stay the first import: it patches Trusted Types policy creation before
// Svelte's runtime is evaluated, without which this script throws on
// linkedin.com and the panel never mounts (#379). See the module's own note.
import './shared/trusted-types-shim.js';
import { claimDocument } from './shared/claim-document.js';
import { api, type AcceptRefusalReason, type SuggestEvent, type SuggestUsage } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import { mountPanel, panelFor, type PanelHandle } from './shared/panel-host.js';
import { insertComposerText, watchDraftForSend } from './linkedin-comment.js';
import {
  detectPageKind,
  findCommentComposer,
  findFeedPosts,
  readPostAuthor,
  readPostIdentifier,
  readPostText,
  resetSelectorHealth,
  selectorHealthActivityEvents,
} from './shared/linkedin-dom.js';
import CommentAssistPanel from './linkedin-comment-assist-panel.svelte';

/**
 * In-page LinkedIn comment assist (LI-17, #314; overlay/feed rework wave,
 * 2026-09-07): wires LI-14 (#311)'s panel host to LI-15 (#312)'s suggestion
 * endpoint, on every post card LinkedIn renders - the classic post-detail
 * frontend (`/feed/update/urn:li:activity:<id>/`, `/posts/*`) and the main
 * feed (`/feed/*`) alike. `linkedin-dom.ts`'s "Two frontends, one
 * identifier" still governs what each carries: the feed exposes no activity
 * URN (measured, #365), so a suggestion requested from a feed card sends
 * `authorHandle`/`text`/`url` and no `urn`, and the accept route records it
 * as `identifier: 'author-only'` instead of inventing one.
 *
 * ## Per card, not per page
 *
 * `scanFeedForAssist` wires every post card `findFeedPosts` currently
 * finds, and `init` below attaches one document-level `MutationObserver`
 * (mirroring `linkedin-observe.ts`'s own `scanForNewPosts`) that reruns it
 * as LinkedIn's infinite scroll adds cards. `wiredCards` is a `WeakSet`
 * keyed on the card element itself, never an array position or count:
 * LinkedIn recycles feed DOM nodes as they scroll past, so a marker on the
 * node - not an index a recycle would invalidate - is what keeps a card
 * from being wired a second time. Each newly-seen card gets its own
 * short-lived watcher for the comment composer LinkedIn renders lazily,
 * behind the human's own "Comment" click; it disconnects the moment that
 * composer appears.
 *
 * ## One signal, not two clicks (#439)
 *
 * The human's click into LinkedIn's own comment box is the intent signal -
 * the same one `linkedin-comment.ts`'s `wireComposerInsert` already reads as
 * "the human wants to comment" - and asking for a second click on a
 * "Suggest a comment" button bought nothing: by then they had already told
 * us. So mounting now starts the request itself, and the panel's first
 * visible state is `streaming` rather than `resting`.
 *
 * Three guards keep that from becoming a surprise bill or an override:
 * a composer that already holds the human's own text mounts in `resting`
 * with the request behind its button, because generating over something
 * half-written is worse than waiting to be asked; a card whose suggestion
 * was already generated and then dismissed re-renders that result from
 * `lastResultFor` instead of paying for it twice; and no click is ever
 * synthesised, here or anywhere in this directory (compliance rule 3).
 *
 * ## No second send path
 *
 * Accept calls the same materialise-a-draft endpoint LI-16 (#313) built,
 * inserts the accepted text with `insertComposerText` (native setter, a
 * genuine `input` event, never a synthetic submit), then hands the draft id
 * to `watchDraftForSend` - the exact send-detection state machine
 * `linkedin-comment.ts` already uses for a draft opened from the Inbox. An
 * in-page comment therefore lands in the ledger by exactly the same route.
 *
 * ## Reasoning is never insertable (#382)
 *
 * The server splits a model's answer into `reasoning` and `draft` at the
 * envelope marker (`shared/src/assist/envelope.ts`) and this client never
 * re-merges them: `CommentAssistState` carries the two apart through every
 * phase that has both, the accept button only ever sends `draft`, and a
 * `done` event whose `draft` is `null` renders no insert affordance at all
 * (the `no_draft` phase below) - honestly distinguishing a model that chose
 * not to write one from one that ignored the envelope format. The fail-safe
 * is "no marker means no draft", closing #382 (a refusal used to arrive as
 * insertable reasoning text).
 *
 * ## Every accepted draft lands under the personal project
 *
 * `GET /api/extension/linkedin-assist`'s `personalProjectId` (decision 5)
 * is the org's auto-created `personal` project - every accepted suggestion
 * here is filed under it, distinct from `boundProjectId`
 * (`assist.projectId`), which stays what it always was: the product the
 * suggestion is grounded in and generated for, used only for `api.suggest`.
 */

const COMMENT_KIND = 'post_comment';

/** The context a comment suggestion is requested for. `urn` is present only
 * on the classic post-detail frontend - a feed card has none (see the
 * module doc comment's "Two frontends, one identifier" note). */
export type AssistPost = {
  urn?: string;
  authorHandle?: string;
  authorName?: string;
  text: string;
  url: string;
};

/**
 * `post`'s context for a suggestion request, honest about what each
 * frontend actually exposes - see `AssistPost`'s own doc comment. Returns
 * `null` when `readPostText` finds nothing substantial to draft from, the
 * same "nothing honest to send" posture `linkedin-observe.ts` uses.
 * Exported for testing.
 */
export function readAssistPostFromCard(
  post: Element,
  root: ParentNode = document,
): AssistPost | null {
  const identifier = readPostIdentifier(post, root);
  const author = readPostAuthor(post, root);
  const text = readPostText(post, root);
  if (!text) return null;
  return {
    urn: identifier.kind === 'urn' ? identifier.value : undefined,
    authorHandle: author.handle ?? undefined,
    authorName: author.name ?? undefined,
    text,
    url: location.href,
  };
}

/**
 * `readAssistPostFromCard` for whichever post `findFeedPosts` finds first
 * under `root` - the classic post-detail page's own single article, or a
 * caller that has not resolved a specific feed card yet.
 */
export function readAssistPost(root: ParentNode = document): AssistPost | null {
  const post = findFeedPosts(root)[0];
  return post ? readAssistPostFromCard(post, root) : null;
}

/** Every refusal this panel can render, honestly and distinctly (the brief's
 * five states, plus the accept path's own three, plus four this client
 * detects itself). `no_recent_activity` is excluded: it only ever answers a
 * `kind: 'post'` request (#315's post composer assist grounds itself in the
 * observation buffer; this comment assist always supplies its own post
 * text, so it can never hit that refusal). A `done` event with no draft is
 * never a refusal - see `CommentAssistState.no_draft` below. */
export type AssistRefusal =
  | Exclude<AcceptRefusalReason, 'no_recent_activity'>
  | 'backend_unreachable'
  | 'selector_health_degraded'
  | 'generation_failed'
  | 'extension_reloaded';

const KNOWN_REFUSALS: Record<AssistRefusal, true> = {
  assist_disabled: true,
  kill_switch: true,
  project_not_bound: true,
  quota_exhausted: true,
  no_account: true,
  blocked: true,
  uncontactable: true,
  recently_contacted: true,
  backend_unreachable: true,
  selector_health_degraded: true,
  generation_failed: true,
  extension_reloaded: true,
};

/**
 * Whether this script can still reach the extension it came from.
 *
 * When the extension is reloaded or updated, the content scripts already
 * running in open tabs keep running against a dead context: `chrome.runtime`
 * loses its `id`, and every request they make is answered with
 * `net::ERR_FAILED` against `chrome-extension://invalid/`. Measured
 * 2026-09-08 while driving a real page after a reload: the panel reported
 * "Could not reach the Pitchbox backend", which is a lie the human cannot
 * act on - the backend was up and answering `curl` at the same moment. The
 * only fix on this side of the boundary is a page reload, so the panel now
 * says that instead (#438).
 */
function extensionContextAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
  } catch {
    // Touching `chrome.runtime` itself throws in some invalidated contexts.
    return false;
  }
}

/**
 * Maps a refusal reason to its own i18n key rather than a generic failure
 * message - every reason above is real and actionable (a kill switch is not
 * a quota, a blocklist hit is not a missing account), so the panel should
 * always say which one it is. A reason this client does not recognise still
 * renders, naming itself, instead of a blank screen or a raw untranslated
 * key. Exported for testing.
 */
export function refusalMessage(reason: string): {
  key: string;
  params?: Record<string, string>;
} {
  if (reason in KNOWN_REFUSALS) return { key: `assist.refusal.${reason}` };
  return { key: 'assist.refusal.unknown', params: { reason } };
}

/**
 * State machine (#382): `reasoning` and `draft` travel apart through every
 * phase that carries both, so nothing here can ever hand the model's
 * reasoning to `insertComposerText`. `no_draft` is reachable only from a
 * `done` event whose `draft` was `null` - never from a refusal (the assist
 * gate itself, or a mid-stream `failed`) - and carries `skipped` so the
 * panel can say honestly which of the two causes it was: the model chose
 * not to write one (`true`), or it ignored the envelope format (`false`).
 */
export type CommentAssistState =
  | { phase: 'resting' }
  | { phase: 'streaming'; status: 'reading' | 'writing'; reasoning: string; draft: string }
  | { phase: 'ready'; reasoning: string; draft: string }
  | { phase: 'edited'; reasoning: string; draft: string }
  | { phase: 'accepting'; reasoning: string; draft: string }
  | { phase: 'inserted' }
  | { phase: 'no_draft'; reasoning: string; skipped: boolean }
  | { phase: 'refused'; messageKey: string; messageParams?: Record<string, string> };

export type CommentAssistPanelProps = {
  subject?: string;
  state: CommentAssistState;
  onRequest: () => void;
  onEditChange: (text: string) => void;
  onAccept: () => void;
  onDismiss: () => void;
};

/** `composer`'s own comment form, so the panel sits right under the whole
 * control row (emoji/photo buttons included), not just the editable div. */
function resolveAnchor(composer: HTMLElement): Element {
  return composer.closest('form') ?? composer;
}

function logRefusal(reason: string): void {
  logFromContent({
    level: 'warn',
    source: 'linkedin-action',
    message: 'activity.linkedin-action.suggestion-refused',
    messageParams: { reason },
    meta: { reason, script: 'linkedin-comment-assist' },
  });
}

/** #382: a `done` event with no draft is never a refusal, so it gets its own
 * log message rather than reusing `logRefusal` - `skipped: true` is the
 * model working as designed (info), `skipped: false` is it ignoring the
 * envelope format (warn, worth a closer look). */
function logNoDraft(skipped: boolean): void {
  logFromContent({
    level: skipped ? 'info' : 'warn',
    source: 'linkedin-action',
    message: 'activity.linkedin-action.suggestion-no-draft',
    messageParams: { skipped: String(skipped) },
    meta: { skipped, script: 'linkedin-comment-assist' },
  });
}

/**
 * The last terminal result per composer anchor (#439). Keyed on the element
 * so LinkedIn recycling a feed card drops its entry with it, exactly like
 * `wiredCards`. Reopening a card the human already generated for and then
 * dismissed re-renders this instead of spending a second model call on the
 * same post; a `refused` or `no_draft` outcome is deliberately not cached,
 * since both are worth retrying (a quota resets, a kill switch is flipped
 * back, a model given the same post twice can answer differently).
 */
const lastResultFor = new WeakMap<Element, CommentAssistState>();

/** True when LinkedIn's composer already holds text the human typed. Their
 * half-written comment is intent we must not generate over, so the panel
 * waits to be asked in that one case (#439). */
export function composerHasOwnText(composer: HTMLElement): boolean {
  return (composer.textContent ?? '').trim().length > 0;
}

/**
 * Mounts the assist panel on `composer`'s anchor and wires its whole state
 * machine: request, edit, accept-then-insert-then-watch, refuse. One call
 * per composer click (see `wireCommentAssist` below); `mountPanel` itself is
 * what keeps a second click from stacking a second panel (D11). `post` is
 * the specific feed card `composer` belongs to when the caller already
 * resolved one (`scanFeedForAssist` below); omitted, this falls back to
 * whichever post `findFeedPosts` finds first under `document` - the classic
 * post-detail page's own single article.
 */
function mountAssistPanel(composer: HTMLElement, post?: Element): void {
  const anchor = resolveAnchor(composer);
  const capturedPost = post ? readAssistPostFromCard(post, document) : readAssistPost(document);
  for (const event of selectorHealthActivityEvents()) logFromContent(event);

  let currentReasoning = '';
  let currentDraft = '';
  let boundProjectId: number | null = null;
  let personalProjectId: number | null = null;
  let lastUsage: SuggestUsage | undefined;
  let lastMs: number | undefined;

  // What the panel shows the instant it appears, and whether anything is
  // asked for at all (#439): a result already generated for this card, then
  // the human's own half-written text, then the ordinary case - straight
  // into the request, with no button in between.
  const cached = lastResultFor.get(anchor);
  const initial: CommentAssistState = cached ?? { phase: 'resting' };
  if (cached && (cached.phase === 'ready' || cached.phase === 'edited')) {
    currentReasoning = cached.reasoning;
    currentDraft = cached.draft;
  }
  const autoRequest = !cached && !composerHasOwnText(composer);

  const props: CommentAssistPanelProps = {
    subject: capturedPost?.authorName ?? undefined,
    state: initial,
    onRequest: () => void requestSuggestion(),
    onEditChange: (text) => {
      currentDraft = text;
      // Cached so reopening the card brings back what the human had already
      // edited, not the model's original wording (#439).
      const edited: CommentAssistState = {
        phase: 'edited',
        reasoning: currentReasoning,
        draft: text,
      };
      lastResultFor.set(anchor, edited);
      if (handle.alive) handle.update({ state: edited });
    },
    onAccept: () => void acceptAndInsert(),
    onDismiss: () => handle.destroy(),
  };

  const handle: PanelHandle<CommentAssistPanelProps> = mountPanel({
    anchor,
    component: CommentAssistPanel,
    props,
    onDismiss: () => handle.destroy(),
  });

  if (autoRequest) void requestSuggestion();

  function setRefused(reason: string): void {
    logRefusal(reason);
    const { key, params } = refusalMessage(reason);
    if (handle.alive) {
      handle.update({ state: { phase: 'refused', messageKey: key, messageParams: params } });
    }
  }

  async function requestSuggestion(): Promise<void> {
    if (!capturedPost) {
      setRefused('selector_health_degraded');
      return;
    }
    // Checked before the request, not inferred from its failure: a dead
    // context fails the same way an unreachable backend does (#438).
    if (!extensionContextAlive()) {
      setRefused('extension_reloaded');
      return;
    }
    handle.update({ state: { phase: 'streaming', status: 'reading', reasoning: '', draft: '' } });

    const assistRes = await api.linkedinAssist();
    if (!handle.alive) return;
    if (!assistRes.ok) {
      setRefused('backend_unreachable');
      return;
    }
    const { assist } = assistRes.data;
    if (assist.killSwitch) {
      setRefused('kill_switch');
      return;
    }
    if (!assist.enabled) {
      setRefused('assist_disabled');
      return;
    }
    if (assist.projectId === null) {
      setRefused('project_not_bound');
      return;
    }
    boundProjectId = assist.projectId;
    personalProjectId = assist.personalProjectId;

    let reasoning = '';
    let draft = '';
    const res = await api.suggest(
      {
        projectId: boundProjectId,
        kind: COMMENT_KIND,
        post: {
          urn: capturedPost.urn,
          authorHandle: capturedPost.authorHandle,
          authorName: capturedPost.authorName,
          text: capturedPost.text,
          url: capturedPost.url,
        },
      },
      (event: SuggestEvent) => {
        if (!handle.alive) return;
        switch (event.kind) {
          case 'status':
            handle.update({
              state: { phase: 'streaming', status: event.phase, reasoning, draft },
            });
            break;
          case 'chunk':
            if (event.section === 'reasoning') reasoning += event.text;
            else draft += event.text;
            handle.update({ state: { phase: 'streaming', status: 'writing', reasoning, draft } });
            break;
          case 'done':
            lastUsage = event.usage;
            lastMs = event.ms;
            currentReasoning = event.reasoning;
            if (event.draft === null) {
              logNoDraft(event.skipped);
              handle.update({
                state: { phase: 'no_draft', reasoning: event.reasoning, skipped: event.skipped },
              });
            } else {
              currentDraft = event.draft;
              const ready: CommentAssistState = {
                phase: 'ready',
                reasoning: event.reasoning,
                draft: event.draft,
              };
              lastResultFor.set(anchor, ready);
              handle.update({ state: ready });
            }
            break;
          case 'failed':
            setRefused('generation_failed');
            break;
          case 'refused':
            setRefused(event.reason);
            break;
        }
      },
    );
    if (!handle.alive) return;
    if (!res.ok) setRefused('backend_unreachable');
  }

  async function acceptAndInsert(): Promise<void> {
    if (personalProjectId === null || !capturedPost) {
      setRefused('selector_health_degraded');
      return;
    }
    handle.update({
      state: { phase: 'accepting', reasoning: currentReasoning, draft: currentDraft },
    });
    const res = await api.acceptSuggestion({
      projectId: personalProjectId,
      kind: COMMENT_KIND,
      post: {
        urn: capturedPost.urn,
        authorHandle: capturedPost.authorHandle,
        authorName: capturedPost.authorName,
        url: capturedPost.url,
      },
      body: currentDraft,
      usage: lastUsage,
      ms: lastMs,
    });
    if (!handle.alive) return;
    if (!res.ok) {
      setRefused('backend_unreachable');
      return;
    }
    if (!res.data.accepted) {
      setRefused(res.data.refused);
      return;
    }

    insertComposerText(composer, currentDraft);
    watchDraftForSend(res.data.draftId);
    logFromContent({
      level: 'info',
      source: 'linkedin-action',
      message: 'activity.linkedin-action.suggestion-inserted',
      messageParams: { draftId: res.data.draftId },
      meta: { draftId: res.data.draftId },
    });
    handle.update({ state: { phase: 'inserted' } });
  }
}

/**
 * Wires the human's own click into `composer` to mount the assist panel.
 * Never dispatches a click; only listens for one, matching every other
 * content script in this directory. `post` scopes which card `composer`
 * belongs to - see `mountAssistPanel`'s own doc comment. Exported for
 * testing.
 */
export function wireCommentAssist(composer: HTMLElement, post?: Element): void {
  const anchor = resolveAnchor(composer);
  composer.addEventListener(
    'click',
    () => {
      if (panelFor(anchor)) return;
      mountAssistPanel(composer, post);
    },
    { capture: true },
  );
}

// Per-card wiring (#382 wave, decision 2): `wiredCards` is a marker on the
// element itself, not an array position - see the module doc comment's
// "Per card, not per page" section for why that distinction matters on a
// feed that recycles DOM nodes as it scrolls.
const wiredCards = new WeakSet<Element>();

/** True once this script instance has wired at least one real comment
 * composer - the classic post-detail "not found" diagnostic in `init` below
 * reads this rather than re-deriving it. */
let composerEverFound = false;

/** Watches `post` for the comment composer LinkedIn renders lazily, behind
 * the human's own "Comment" click, and wires it the moment it appears. A
 * short-lived, per-card observer: it disconnects itself once found, unlike
 * `init`'s own document-level one below, which keeps watching for new
 * cards for the tab's whole lifetime. */
function watchCardForComposer(post: Element): void {
  const composer = findCommentComposer(post);
  if (composer) {
    composerEverFound = true;
    wireCommentAssist(composer, post);
    return;
  }
  const obs = new MutationObserver(() => {
    const found = findCommentComposer(post);
    if (found) {
      composerEverFound = true;
      obs.disconnect();
      wireCommentAssist(found, post);
    }
  });
  obs.observe(post, { childList: true, subtree: true });
}

/**
 * Wires every post card `findFeedPosts` currently finds under `root` that
 * is not already wired. Exported so a test can call this directly, proving
 * a second call - mirroring `init`'s own `MutationObserver` firing again on
 * an unrelated mutation - never wires the same card twice: `wiredCards` is
 * checked before anything else happens for that card.
 */
export function scanFeedForAssist(root: ParentNode = document): void {
  for (const post of findFeedPosts(root)) {
    if (wiredCards.has(post)) continue;
    wiredCards.add(post);
    watchCardForComposer(post);
  }
}

const COMPOSER_WAIT_MS = 15_000;

function init(): void {
  resetSelectorHealth();
  scanFeedForAssist();
  // This observer never disconnects (new cards can arrive for the tab's
  // whole lifetime), so its callback can still be queued for delivery after
  // the page context it was watching is gone - a navigation away, or the
  // extension itself reloading mid-session. `document` is a bare global at
  // that point, not merely empty, so this guards the access itself rather
  // than trusting a null check downstream (mirrors linkedin-post-assist.ts's
  // own `tryWire`).
  const obs = new MutationObserver(() => {
    if (typeof document === 'undefined') return;
    scanFeedForAssist();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Only the classic post-detail page renders its composer at load time (see
  // the module doc comment); a feed card's composer is lazy, behind the
  // human's own "Comment" click, so nothing appearing there within the wait
  // is ordinary browsing, not a broken selector. The diagnostic below is
  // only meaningful for the page kind where a composer really should always
  // be present almost immediately.
  if (detectPageKind(document) !== 'post-detail-classic') return;
  window.setTimeout(() => {
    if (composerEverFound) return;
    for (const event of selectorHealthActivityEvents()) logFromContent(event);
    logFromContent({
      level: 'warn',
      source: 'linkedin-action',
      message: 'activity.linkedin-action.assist-composer-not-found',
      meta: {
        script: 'linkedin-comment-assist',
        selector: 'findCommentComposer',
        reason: 'comment-composer-not-found',
        url: location.href,
      },
    });
  }, COMPOSER_WAIT_MS);
}

if (claimDocument('linkedin-comment-assist')) init();
