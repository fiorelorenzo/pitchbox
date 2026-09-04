import { api, type AcceptRefusalReason, type SuggestEvent, type SuggestUsage } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import { mountPanel, panelFor } from './shared/panel-host.js';
import { insertComposerText, hasInlineCommentError } from './linkedin-comment.js';
import {
  findPostComposer,
  findPostComposerModal,
  findPostSubmitButton,
  resetSelectorHealth,
  selectorHealthActivityEvents,
} from './shared/linkedin-dom.js';
import PostAssistPanel from './linkedin-post-assist-panel.svelte';

/**
 * In-page LinkedIn post composer assist (LI-18, #315): the other half of
 * LI-17's comment assist (#314, `linkedin-comment-assist.ts`), wired to
 * LI-14's panel host and LI-15's suggestion endpoint (`kind: 'post'`), but
 * on LinkedIn's own "Start a post" composer rather than a comment box.
 *
 * ## Registered on the feed, not on a single post
 *
 * The comment assist registers against `/feed/update/*` - the one page that
 * both renders a comment composer and exposes a stable post identifier (see
 * `linkedin-dom.ts`'s "Two frontends, one identifier"). The post composer has
 * neither concern: it opens as a modal reachable from the top of the main
 * feed, not from any one post's own page, so this registers against
 * `/feed*` instead (`linkedin-post-assist-registration.ts`).
 *
 * ## Grounded through the server, not by scraping the feed itself
 *
 * A comment suggestion is grounded in the one post the human is reading -
 * this script reads it and sends it along. A post suggestion has nothing
 * equivalent: the composer is a blank box, not a post. Rather than have this
 * script scrape a pile of feed posts and hand them to the suggestion
 * endpoint (which would make this script's own DOM reach much larger, and
 * duplicate what the passive observation collector, `linkedin-observe.ts`,
 * already does more carefully with `IntersectionObserver` gating and
 * dedup), the suggestion endpoint grounds `kind: 'post'` itself, server-side,
 * in the most recent thing the observation buffer has actually collected for
 * this project (`shared/src/observed-targets.ts`'s `loadRecentObservedTarget`,
 * wired into `POST /api/extension/suggest`). This script sends only the
 * current page URL for context - never post text it read itself.
 *
 * ## Never unprompted, twice over
 *
 * Same discipline as the comment assist. `wirePostAssist` only mounts once
 * the human has already clicked into LinkedIn's own post editor (the modal
 * has to be open for that to be possible at all), and the mounted panel
 * starts in `resting` - present, nothing requested. Only the panel's own
 * "Suggest a post" control fires the network request. Neither click is ever
 * synthesised.
 *
 * ## No URN after publish - completion detection stops at "armed"
 *
 * A comment's URN can be confirmed the moment it posts: the classic
 * post-detail frontend renders it as `article[data-id]`
 * (`linkedin-comment.ts`'s `findOurCommentUrn`). A freshly published post has
 * no equivalent this module can read. `linkedin-dom.ts`'s own header
 * documents the exhaustive search behind this (#303): on the SDUI feed the
 * activity URN "is not in the feed DOM, not inside any shadow root, not in
 * any inline script, and not reachable through React's fiber or memoized
 * props" - and that is exactly the frontend a freshly published post renders
 * into. So this script arms the draft on the human's own click of LinkedIn's
 * "Post" control (never dispatches one) and watches for the composer closing
 * without an inline error, but it never calls the `sent` endpoint the way
 * the comment watcher does: there is no `platform_post_id` to give it, and
 * writing one down without an identifier would be a fabricated confirmation,
 * not a detected one. The draft stays `armed` for a human to resolve.
 *
 * What a human with a live account would need to capture before this can go
 * further: right after publishing a real post from this composer, does
 * *anything* on the page expose the new post's URN - a `data-urn` on the
 * fresh top-of-feed card, a `data-sdui-anchor-id` keyed to it, a network
 * response body the browser's own devtools can see, or does navigating to
 * the profile's own `/recent-activity/` page render it through the classic
 * frontend with a real `data-urn`? None of the fixtures in this repo show
 * that state, so none of it is guessed here.
 */

const POST_KIND = 'post';

/** Every refusal this panel can render, honestly and distinctly. A subset of
 * the comment assist's own `AssistRefusal` (LI-17): a `post` suggestion never
 * targets one person, so the accept path's `uncontactable`/`recently_contacted`
 * refusals (only reachable with a `targetUser`, see `shared/src/assist-accept.ts`)
 * can never fire here, and this script never reads post content off the page,
 * so `selector_health_degraded` cannot fire either. `no_recent_activity` is
 * new: the observation buffer this suggestion grounds in (see the module doc
 * comment) had nothing recent enough to draft from. */
export type PostAssistRefusal =
  | Exclude<AcceptRefusalReason, 'uncontactable' | 'recently_contacted'>
  | 'backend_unreachable'
  | 'generation_failed'
  | 'no_recent_activity';

const KNOWN_REFUSALS: Record<PostAssistRefusal, true> = {
  assist_disabled: true,
  kill_switch: true,
  project_not_bound: true,
  quota_exhausted: true,
  no_recent_activity: true,
  no_account: true,
  blocked: true,
  backend_unreachable: true,
  generation_failed: true,
};

/**
 * Maps a refusal reason to its own i18n key. `quota_exhausted` gets a key
 * distinct from the comment assist's own (`assist.refusal.post_quota_exhausted`
 * vs `assist.refusal.quota_exhausted`): the server answers the same reason
 * string either way, but "today's comment quota is used up" would be a lie
 * on this surface - the post quota ships separately, at one a day. Every
 * other reason reuses the comment assist's own message, which names nothing
 * kind-specific. A reason this client does not recognise still renders,
 * naming itself, instead of a blank or a raw untranslated key. Exported for
 * testing.
 */
export function refusalMessage(reason: string): {
  key: string;
  params?: Record<string, string>;
} {
  if (reason === 'quota_exhausted') return { key: 'assist.refusal.post_quota_exhausted' };
  if (reason in KNOWN_REFUSALS) return { key: `assist.refusal.${reason}` };
  return { key: 'assist.refusal.unknown', params: { reason } };
}

export type PostAssistState =
  | { phase: 'resting' }
  | { phase: 'streaming'; status: 'reading' | 'writing'; text: string }
  | { phase: 'ready'; text: string }
  | { phase: 'edited'; text: string }
  | { phase: 'accepting'; text: string }
  | { phase: 'inserted' }
  | { phase: 'refused'; messageKey: string; messageParams?: Record<string, string> };

export type PostAssistPanelProps = {
  state: PostAssistState;
  onRequest: () => void;
  onEditChange: (text: string) => void;
  onAccept: () => void;
  onDismiss: () => void;
};

// `editor`'s own form when it has one, matching `linkedin-comment-assist.ts`'s
// anchor resolution exactly - unverified for the post composer (no fixture
// shows its modal open, see the module doc comment), so this falls back to
// the editor itself with the same posture that script does.

const POST_CONFIRM_POLL_MS = 500;
const POST_CONFIRM_TIMEOUT_MS = 20_000;
const POST_SUBMIT_WAIT_MS = 15_000;

/**
 * Arms `draftId` on the human's own click of LinkedIn's post-composer submit
 * control found under `modal` (never dispatches one), then watches for the
 * modal closing cleanly. Never calls `api.sent` - see the module doc
 * comment's "No URN after publish" section for why that would be a
 * fabricated confirmation rather than a detected one. Exported for testing.
 */
export function wirePostSubmit(modal: Element, draftId: number): boolean {
  const btn = findPostSubmitButton(modal);
  if (!btn) return false;
  let armed = false;
  btn.addEventListener(
    'click',
    () => {
      if (armed) return;
      armed = true;
      void api.armed(draftId);
      let resolved = false;
      const finish = (message: string, reason: string) => {
        if (resolved) return;
        resolved = true;
        window.clearInterval(poll);
        window.clearTimeout(giveUp);
        logFromContent({
          level: 'warn',
          source: 'linkedin-action',
          message,
          messageParams: { draftId },
          meta: { draftId, script: 'linkedin-post-assist', reason, url: location.href },
        });
      };
      const poll = window.setInterval(() => {
        if (hasInlineCommentError()) {
          // LinkedIn showed an inline error - leave the draft armed for a
          // retry, nothing resolved yet.
          window.clearInterval(poll);
          window.clearTimeout(giveUp);
          return;
        }
        if (findPostComposerModal()) return; // still open/submitting
        finish('activity.linkedin-action.post-confirm-unavailable', 'no-post-identifier-in-dom');
      }, POST_CONFIRM_POLL_MS);
      const giveUp = window.setTimeout(() => {
        finish('activity.linkedin-action.post-confirm-timeout', 'confirm-poll-timeout');
      }, POST_CONFIRM_TIMEOUT_MS);
    },
    { capture: true },
  );
  return true;
}

/**
 * Wires `wirePostSubmit` now if the submit control already exists under
 * `modal`, or retries via `MutationObserver` scoped to the modal - LinkedIn
 * does not render a submit control for an empty composer, matching
 * `linkedin-comment.ts`'s `watchForCommentSubmit` (this is the expected path
 * right after inserting text, not a fallback) - for up to 15s before logging
 * a distinct give-up.
 */
function watchPostForSend(modal: Element, draftId: number): void {
  if (wirePostSubmit(modal, draftId)) return;
  let wired = false;
  const obs = new MutationObserver(() => {
    if (wirePostSubmit(modal, draftId)) {
      wired = true;
      obs.disconnect();
    }
  });
  obs.observe(modal, { childList: true, subtree: true });
  window.setTimeout(() => {
    obs.disconnect();
    if (wired) return;
    logFromContent({
      level: 'warn',
      source: 'linkedin-action',
      message: 'activity.linkedin-action.post-submit-not-found',
      messageParams: { draftId },
      meta: {
        draftId,
        script: 'linkedin-post-assist',
        step: 'wire-submit-button',
        selector: 'findPostSubmitButton',
        reason: 'submit-button-not-found',
        url: location.href,
      },
    });
  }, POST_SUBMIT_WAIT_MS);
}

/**
 * Mounts the assist panel on `editor`'s anchor and wires its whole state
 * machine: request, edit, accept-then-insert-then-arm, refuse. One call per
 * modal open (see `wirePostAssist` below); `mountPanel` itself is what keeps
 * a second click from stacking a second panel.
 */
function mountAssistPanel(editor: HTMLElement, modal: Element): void {
  const anchor = editor.closest('form') ?? editor;
  for (const event of selectorHealthActivityEvents()) logFromContent(event);

  let currentText = '';
  let boundProjectId: number | null = null;
  let lastUsage: SuggestUsage | undefined;
  let lastMs: number | undefined;

  const props: PostAssistPanelProps = {
    state: { phase: 'resting' },
    onRequest: () => void requestSuggestion(),
    onEditChange: (text) => {
      currentText = text;
      if (handle.alive) handle.update({ state: { phase: 'edited', text } });
    },
    onAccept: () => void acceptAndInsert(),
    onDismiss: () => handle.destroy(),
  };

  const handle = mountPanel({ anchor, component: PostAssistPanel, props });

  function setRefused(reason: string): void {
    logFromContent({
      level: 'warn',
      source: 'linkedin-action',
      message: 'activity.linkedin-action.suggestion-refused',
      messageParams: { reason },
      meta: { reason, script: 'linkedin-post-assist' },
    });
    const { key, params } = refusalMessage(reason);
    if (handle.alive) {
      handle.update({ state: { phase: 'refused', messageKey: key, messageParams: params } });
    }
  }

  async function requestSuggestion(): Promise<void> {
    handle.update({ state: { phase: 'streaming', status: 'reading', text: '' } });

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

    let streamed = '';
    // Never a pile of observed posts: the server itself reads the
    // observation buffer for `kind: 'post'` (see the module doc comment).
    // `post` here is informational context only.
    const res = await api.suggest(
      { projectId: boundProjectId, kind: POST_KIND, post: { url: location.href } },
      (event: SuggestEvent) => {
        if (!handle.alive) return;
        switch (event.kind) {
          case 'status':
            handle.update({ state: { phase: 'streaming', status: event.phase, text: streamed } });
            break;
          case 'chunk':
            streamed += event.text;
            handle.update({ state: { phase: 'streaming', status: 'writing', text: streamed } });
            break;
          case 'done':
            lastUsage = event.usage;
            lastMs = event.ms;
            currentText = event.text;
            handle.update({ state: { phase: 'ready', text: event.text } });
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
    if (boundProjectId === null) {
      setRefused('backend_unreachable');
      return;
    }
    handle.update({ state: { phase: 'accepting', text: currentText } });
    const res = await api.acceptSuggestion({
      projectId: boundProjectId,
      kind: POST_KIND,
      // No urn (a post has none until it publishes), no authorHandle/authorName
      // (this is the operator's own voice, not a reply to someone) - see
      // web/src/routes/api/extension/suggest/accept/+server.ts's targetUser
      // handling for `kind: 'post'`.
      post: {},
      body: currentText,
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

    insertComposerText(editor, currentText);
    watchPostForSend(modal, res.data.draftId);
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
 * Wires the human's own click into `editor` to mount the assist panel.
 * Never dispatches a click; only listens for one, matching every other
 * content script in this directory. Exported for testing.
 */
export function wirePostAssist(editor: HTMLElement, modal: Element): void {
  const anchor = editor.closest('form') ?? editor;
  editor.addEventListener(
    'click',
    () => {
      if (panelFor(anchor)) return;
      mountAssistPanel(editor, modal);
    },
    { capture: true },
  );
}

// The "Start a post" modal can open, close and reopen any number of times
// across this script's lifetime (a feed page never reloads for it), unlike
// the comment assist's one-shot page-load wait - so this observer never
// disconnects, and `wiredEditors` is what keeps a still-open modal from
// getting a second, redundant listener on every unrelated DOM mutation.
const wiredEditors = new WeakSet<HTMLElement>();

function tryWire(): void {
  // This observer never disconnects (see above), so its callback can still
  // be queued for delivery after the page context it was watching is gone -
  // a navigation away, or the extension itself reloading mid-session.
  // `document` is a bare global at that point, not merely empty, so this
  // guards the access itself rather than trusting a null check downstream.
  if (typeof document === 'undefined') return;
  const modal = findPostComposerModal();
  if (!modal) return;
  const editor = findPostComposer(modal);
  if (!editor || wiredEditors.has(editor)) return;
  wiredEditors.add(editor);
  wirePostAssist(editor, modal);
}

function init(): void {
  resetSelectorHealth();
  tryWire();
  const obs = new MutationObserver(tryWire);
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

init();
