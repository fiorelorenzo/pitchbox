import { api, type AcceptRefusalReason, type SuggestEvent, type SuggestUsage } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import { mountPanel, panelFor } from './shared/panel-host.js';
import { insertComposerText, watchDraftForSend } from './linkedin-comment.js';
import {
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
 * In-page LinkedIn comment assist (LI-17, #314): wires LI-14 (#311)'s panel
 * host to LI-15 (#312)'s suggestion endpoint on the classic post-detail page
 * (`/feed/update/urn:li:activity:<id>/`), the only frontend that renders a
 * comment composer or exposes a stable post identifier at all - see
 * `linkedin-dom.ts`'s "Two frontends, one identifier". The feed itself has
 * neither in the anonymised captures this module is tested against, so it is
 * out of scope here (docs/linkedin-integration-design.md agrees: the panel
 * anchors "to the post the human acted on", D11, exactly like the passive
 * observation collector's own choice not to invent a dedupe key the feed
 * does not expose).
 *
 * ## Never unprompted, twice over
 *
 * Mounting the panel and requesting a suggestion are two separate explicit
 * actions, not one. `wireCommentAssist` only mounts on the human's own click
 * into LinkedIn's already-rendered composer (the same signal
 * `linkedin-comment.ts`'s `wireComposerInsert` already uses to mean "the
 * human wants to comment"), and the mounted panel starts in `resting` -
 * present, nothing requested (docs/design/linkedin-assistant-brief.md,
 * "States"). Only a second click, on the panel's own "Suggest a comment"
 * control, fires the network request. Neither click is ever synthesised.
 *
 * ## No second send path
 *
 * Accept calls the same materialise-a-draft endpoint LI-16 (#313) built,
 * inserts the accepted text with `insertComposerText` (native setter, a
 * genuine `input` event, never a synthetic submit), then hands the draft id
 * to `watchDraftForSend` - the exact send-detection state machine
 * `linkedin-comment.ts` already uses for a draft opened from the Inbox. An
 * in-page comment therefore lands in the ledger by exactly the same route.
 */

const COMMENT_KIND = 'post_comment';

/** The observed post context a suggestion is requested for. `urn` is only
 * present because this module only runs on the classic post-detail page -
 * see the module doc comment. */
export type AssistPost = {
  urn?: string;
  authorHandle?: string;
  authorName?: string;
  text: string;
  url: string;
};

/**
 * Reads the one post on a classic post-detail page through `linkedin-dom.ts`.
 * Returns null when there is no post, or no readable body text - a request
 * built from an empty post is not a degraded suggestion, it is nothing to
 * suggest from, so the caller renders `selector_health_degraded` instead of
 * sending it. Exported for testing.
 */
export function readAssistPost(root: ParentNode = document): AssistPost | null {
  const post = findFeedPosts(root)[0];
  if (!post) return null;
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

/** Every refusal this panel can render, honestly and distinctly (the brief's
 * five states, plus the accept path's own three, plus three this client
 * detects itself). `no_recent_activity` is excluded: it only ever answers a
 * `kind: 'post'` request (#315's post composer assist grounds itself in the
 * observation buffer; this comment assist always supplies its own post
 * text, so it can never hit that refusal). */
export type AssistRefusal =
  | Exclude<AcceptRefusalReason, 'no_recent_activity'>
  | 'backend_unreachable'
  | 'selector_health_degraded'
  | 'generation_failed';

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
};

/**
 * Maps a refusal reason to its own i18n key rather than a generic failure
 * (docs/design/linkedin-assistant-brief.md, "Refused is five real states...
 * not one error"). A reason this client does not recognise (a future server
 * refusal this build predates) still renders, naming itself, instead of a
 * blank or a raw untranslated key. Exported for testing.
 */
export function refusalMessage(reason: string): {
  key: string;
  params?: Record<string, string>;
} {
  if (reason in KNOWN_REFUSALS) return { key: `assist.refusal.${reason}` };
  return { key: 'assist.refusal.unknown', params: { reason } };
}

export type CommentAssistState =
  | { phase: 'resting' }
  | { phase: 'streaming'; status: 'reading' | 'writing'; text: string }
  | { phase: 'ready'; text: string }
  | { phase: 'edited'; text: string }
  | { phase: 'accepting'; text: string }
  | { phase: 'inserted' }
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

/**
 * Mounts the assist panel on `composer`'s anchor and wires its whole state
 * machine: request, edit, accept-then-insert-then-watch, refuse. One call
 * per composer click (see `wireCommentAssist` below); `mountPanel` itself is
 * what keeps a second click from stacking a second panel (D11).
 */
function mountAssistPanel(composer: HTMLElement): void {
  const anchor = resolveAnchor(composer);
  const capturedPost = readAssistPost(document);
  for (const event of selectorHealthActivityEvents()) logFromContent(event);

  let currentText = '';
  let boundProjectId: number | null = null;
  let lastUsage: SuggestUsage | undefined;
  let lastMs: number | undefined;

  const props: CommentAssistPanelProps = {
    subject: capturedPost?.authorName ?? undefined,
    state: { phase: 'resting' },
    onRequest: () => void requestSuggestion(),
    onEditChange: (text) => {
      currentText = text;
      if (handle.alive) handle.update({ state: { phase: 'edited', text } });
    },
    onAccept: () => void acceptAndInsert(),
    onDismiss: () => handle.destroy(),
  };

  const handle = mountPanel({ anchor, component: CommentAssistPanel, props });

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
    if (boundProjectId === null || !capturedPost) {
      setRefused('selector_health_degraded');
      return;
    }
    handle.update({ state: { phase: 'accepting', text: currentText } });
    const res = await api.acceptSuggestion({
      projectId: boundProjectId,
      kind: COMMENT_KIND,
      post: {
        urn: capturedPost.urn,
        authorHandle: capturedPost.authorHandle,
        authorName: capturedPost.authorName,
        url: capturedPost.url,
      },
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

    insertComposerText(composer, currentText);
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
 * content script in this directory. Exported for testing.
 */
export function wireCommentAssist(composer: HTMLElement): void {
  const anchor = resolveAnchor(composer);
  composer.addEventListener(
    'click',
    () => {
      if (panelFor(anchor)) return;
      mountAssistPanel(composer);
    },
    { capture: true },
  );
}

const COMPOSER_WAIT_MS = 15_000;

function init(): void {
  resetSelectorHealth();
  const composer = findCommentComposer();
  if (composer) {
    wireCommentAssist(composer);
    return;
  }
  let wired = false;
  const obs = new MutationObserver(() => {
    const found = findCommentComposer();
    if (found) {
      wired = true;
      obs.disconnect();
      wireCommentAssist(found);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => {
    obs.disconnect();
    if (wired) return;
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

init();
