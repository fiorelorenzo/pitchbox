// MUST stay the first import: see linkedin-comment-assist.ts and the shim's
// own note. Without it Svelte's runtime throws on linkedin.com's
// `trusted-types` allowlist and this script dies before mounting (#379).
import './shared/trusted-types-shim.js';
import { claimDocument } from './shared/claim-document.js';
import {
  api,
  pickPairing,
  type AcceptRefusalReason,
  type AssistStatusPhase,
  type RetuneDirection,
  type SuggestEvent,
  type SuggestRefusalReason,
  type SuggestUsage,
} from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import { setLocale } from '../lib/i18n/index.js';
import { resolvePanelLocale } from './shared/panel-locale.js';
import { mountPanel, panelFor, type PanelHandle } from './shared/panel-host.js';
import { insertComposerText } from './linkedin-comment.js';
import {
  findPostComposer,
  findPostComposerModal,
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
 * The comment assist registers against every post card it can find - the
 * classic post-detail page and the feed alike (see its own module doc
 * comment). The post composer has no equivalent notion of "which card": it
 * opens as one modal reachable from the top of the main feed, so this
 * registers against `/feed*` (`linkedin-post-assist-registration.ts`) and
 * needs no per-card wiring of its own.
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
 * dedup), the suggestion endpoint grounds `kind: 'post'` itself,
 * server-side, in the most recent thing the observation buffer has
 * actually collected anywhere in the organization (LOR-181: org-wide, not
 * one bound project's buffer - `shared/src/observed-targets.ts`'s
 * `loadRecentObservedTarget`, wired into `POST /api/extension/suggest`).
 * This script sends only the current page URL for context - never post
 * text it read itself.
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
 * ## No draft to arm, no send to watch for (#521)
 *
 * Accept writes straight into the assist plane's own ledger
 * (`shared/src/assist-accept.ts`'s `acceptSuggestion`) the moment the human
 * accepts - unconditionally, not gated behind detecting that the post
 * actually went out. There is no `drafts` row to arm this script used to
 * carry a `draftId` for, and no way to confirm a freshly published post's
 * identity anyway: unlike a comment's URN (confirmable the moment it
 * posts, via the classic frontend's `article[data-id]`), `linkedin-dom.ts`'s
 * own header documents the exhaustive search behind why a freshly
 * published post's own URN is unreachable on the SDUI feed (#303). So this
 * script does not try - `insertComposerText` is the last thing it does with
 * the accepted text, matching the comment assist's own posture.
 *
 * ## Reasoning is never insertable (#382)
 *
 * Same split as the comment assist: `PostAssistState` carries `reasoning`
 * and `draft` apart through every phase that has both, the accept button
 * only ever sends `draft`, and a `done` event whose `draft` is `null`
 * renders no insert affordance - see `no_draft` below.
 *
 * ## Where an accepted suggestion is filed (LOR-181)
 *
 * Same routing as the comment assist: `api.acceptSuggestion` sends the
 * project `done.projectId` named on this suggestion's own request - the
 * server's own choice, from the post, not a project this client bound
 * itself to. There is no separate personal project to fall back to: a
 * `null` `done.projectId` files under none, exactly as the comment assist
 * does. Unlike the comment assist, this kind still has one project-shaped
 * refusal of its own - `no_recent_activity` - because the observation
 * buffer this kind grounds itself in (see the module doc comment) can be
 * empty; it is no longer about whether a project is bound, since nothing
 * is bound here any more.
 */

const POST_KIND = 'post';

/** Every refusal this panel can render, honestly and distinctly. A subset of
 * the comment assist's own `AssistRefusal` (LI-17) plus the one refusal
 * `SuggestRefusalReason` carries that only a `kind: 'post'` request can
 * hit: a `post` suggestion never targets one person, so the accept path's
 * `uncontactable`/`recently_contacted` refusals (only reachable with a
 * `targetUser`, see `shared/src/assist-accept.ts`) can never fire here, and
 * this script never reads post content off the page, so
 * `selector_health_degraded` cannot fire either. `no_recent_activity` is
 * the new one: the observation buffer this suggestion grounds in (see the
 * module doc comment) needs something recent in it, org-wide (LOR-181). A
 * `done` event with no draft is never a refusal - see
 * `PostAssistState.no_draft` below. */
export type PostAssistRefusal =
  | Exclude<AcceptRefusalReason, 'uncontactable' | 'recently_contacted'>
  | SuggestRefusalReason
  | 'backend_unreachable'
  | 'generation_failed';

const KNOWN_REFUSALS: Record<PostAssistRefusal, true> = {
  assist_disabled: true,
  kill_switch: true,
  no_recent_activity: true,
  blocked: true,
  backend_unreachable: true,
  generation_failed: true,
  plan_limit_reached: true,
  plan_payment_required: true,
};

/** Whether `reason` is one #556 gives its own link to billing settings, in
 * a new tab, alongside its message. Mirrors the comment assist's own. */
function billingLinkFor(reason: string): boolean {
  return reason === 'plan_limit_reached' || reason === 'plan_payment_required';
}

/**
 * Maps a refusal reason to its own i18n key - every reason is real and
 * actionable, so the panel always says which one it is rather than a
 * generic failure. A reason this client does not recognise still renders,
 * naming itself, instead of a blank or a raw untranslated key. Exported for
 * testing.
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
 * phase that carries both - see `linkedin-comment-assist.ts`'s own
 * `CommentAssistState` doc comment, which this mirrors exactly.
 */
export type PostAssistState =
  | { phase: 'resting' }
  | { phase: 'streaming'; status: AssistStatusPhase; reasoning: string; draft: string }
  | { phase: 'ready'; reasoning: string; draft: string; budgetExhausted?: boolean }
  | { phase: 'edited'; reasoning: string; draft: string }
  | { phase: 'accepting'; reasoning: string; draft: string }
  | { phase: 'inserted' }
  | { phase: 'no_draft'; reasoning: string; skipped: boolean }
  | {
      phase: 'refused';
      messageKey: string;
      messageParams?: Record<string, string>;
      link?: string;
    };

export type PostAssistPanelProps = {
  state: PostAssistState;
  onRequest: () => void;
  onEditChange: (text: string) => void;
  onAccept: () => void;
  /** #409: see `CommentAssistPanelProps.onRetune`, which this mirrors. */
  onRetune: (direction: RetuneDirection) => void;
  onDismiss: () => void;
};

// `editor`'s own form when it has one, matching `linkedin-comment-assist.ts`'s
// anchor resolution exactly - unverified for the post composer (no fixture
// shows its modal open, see the module doc comment), so this falls back to
// the editor itself with the same posture that script does.

/** #382: a `done` event with no draft is never a refusal, so it gets its own
 * log message - see `linkedin-comment-assist.ts`'s own `logNoDraft`, which
 * this mirrors exactly. */
function logNoDraft(skipped: boolean): void {
  logFromContent({
    level: skipped ? 'info' : 'warn',
    source: 'linkedin-action',
    message: 'activity.linkedin-action.suggestion-no-draft',
    messageParams: { skipped: String(skipped) },
    meta: { skipped, script: 'linkedin-post-assist' },
  });
}

/**
 * Mounts the assist panel on `editor`'s anchor and wires its whole state
 * machine: request, edit, accept-then-insert, refuse. One call per modal
 * open (see `wirePostAssist` below); `mountPanel` itself is what keeps a
 * second click from stacking a second panel.
 */
function mountAssistPanel(editor: HTMLElement, modal: Element): void {
  // Unlike the comment assist's `post`, the top-level post composer modal
  // carries no separate scoping context to read - kept for call-site
  // symmetry with `wireCommentAssist` rather than used here.
  void modal;
  const anchor = editor.closest('form') ?? editor;
  for (const event of selectorHealthActivityEvents()) logFromContent(event);

  let currentReasoning = '';
  let currentDraft = '';
  // LOR-181: captured from `done.projectId` once the model states its
  // choice - never a bound project of this client's own.
  let lastResolvedProjectId: number | null = null;
  let lastUsage: SuggestUsage | undefined;
  let lastMs: number | undefined;
  // #576: the live session id from the last `done` event, if any.
  let lastSessionId: string | undefined;

  const props: PostAssistPanelProps = {
    state: { phase: 'resting' },
    onRequest: () => void requestSuggestion(),
    onEditChange: (text) => {
      currentDraft = text;
      if (handle.alive) {
        handle.update({ state: { phase: 'edited', reasoning: currentReasoning, draft: text } });
      }
    },
    onAccept: () => void acceptAndInsert(),
    onRetune: (direction) => void requestSuggestion(direction),
    onDismiss: () => handle.destroy(),
  };

  const handle: PanelHandle<PostAssistPanelProps> = mountPanel({
    anchor,
    component: PostAssistPanel,
    props,
    onDismiss: () => handle.destroy(),
  });

  async function setRefused(reason: string, detail?: Record<string, unknown>): Promise<void> {
    logFromContent({
      level: 'warn',
      source: 'linkedin-action',
      message: 'activity.linkedin-action.suggestion-refused',
      messageParams: { reason },
      meta: { reason, script: 'linkedin-post-assist', ...detail },
    });
    const { key, params } = refusalMessage(reason);
    let link: string | undefined;
    if (billingLinkFor(reason)) {
      const pairing = await pickPairing();
      if (pairing) link = `${pairing.backendUrl}/settings/billing`;
    }
    if (handle.alive) {
      handle.update({ state: { phase: 'refused', messageKey: key, messageParams: params, link } });
    }
  }

  /** Same guard as the comment panel's: nothing else ever writes this panel's
   * state, so a throw below would leave it in `streaming` forever rather than
   * saying what went wrong. */
  async function requestSuggestion(retune?: RetuneDirection): Promise<void> {
    try {
      await runSuggestion(retune);
    } catch (e) {
      void setRefused('generation_failed', { threw: (e as Error)?.message ?? String(e) });
    }
  }

  async function runSuggestion(retune?: RetuneDirection): Promise<void> {
    handle.update({ state: { phase: 'streaming', status: 'reading', reasoning: '', draft: '' } });

    const assistRes = await api.linkedinAssist();
    if (!handle.alive) return;
    if (!assistRes.ok) {
      void setRefused('backend_unreachable');
      return;
    }
    const { assist } = assistRes.data;
    if (assist.killSwitch) {
      void setRefused('kill_switch');
      return;
    }
    if (!assist.enabled) {
      void setRefused('assist_disabled');
      return;
    }
    // LOR-181: `assist.projectId` is no longer read here - it is the
    // observation collector's own attribution target now, not a suggestion's
    // context. Which project (if any) this suggestion is about is the
    // server's own choice, reported back on `done.projectId` below.

    let reasoning = '';
    let draft = '';
    // Never a pile of observed posts: the server itself reads the
    // observation buffer for `kind: 'post'` (see the module doc comment).
    // `post` here is informational context only.
    const res = await api.suggest(
      {
        kind: POST_KIND,
        post: { url: location.href },
        retune,
        sessionId: lastSessionId,
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
            lastSessionId = event.sessionId;
            lastResolvedProjectId = event.projectId;
            currentReasoning = event.reasoning;
            if (event.draft === null) {
              logNoDraft(event.skipped);
              handle.update({
                state: { phase: 'no_draft', reasoning: event.reasoning, skipped: event.skipped },
              });
            } else {
              currentDraft = event.draft;
              handle.update({
                state: {
                  phase: 'ready',
                  reasoning: event.reasoning,
                  draft: event.draft,
                  budgetExhausted: event.budgetExhausted,
                },
              });
            }
            break;
          case 'failed':
            void setRefused('generation_failed');
            break;
          case 'refused':
            void setRefused(event.reason, event.detail);
            break;
        }
      },
    );
    if (!handle.alive) return;
    if (!res.ok) void setRefused('backend_unreachable');
  }

  async function acceptAndInsert(): Promise<void> {
    handle.update({
      state: { phase: 'accepting', reasoning: currentReasoning, draft: currentDraft },
    });
    const res = await api.acceptSuggestion({
      projectId: lastResolvedProjectId ?? undefined,
      kind: POST_KIND,
      // No urn (a post has none until it publishes), no authorHandle/authorName
      // (this is the operator's own voice, not a reply to someone) - see
      // web/src/routes/api/extension/suggest/accept/+server.ts's targetUser
      // handling for `kind: 'post'`.
      post: {},
      body: currentDraft,
      usage: lastUsage,
      ms: lastMs,
    });
    if (!handle.alive) return;
    if (!res.ok) {
      void setRefused('backend_unreachable');
      return;
    }
    if (!res.data.accepted) {
      void setRefused(res.data.refused);
      return;
    }
    // #521: the ledger row is already written above - there is no draft to
    // arm and no send to watch for.
    insertComposerText(editor, currentDraft);
    logFromContent({
      level: 'info',
      source: 'linkedin-action',
      message: 'activity.linkedin-action.suggestion-inserted',
      messageParams: { id: res.data.id },
      meta: { id: res.data.id },
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

// LOR-261: see linkedin-comment-assist.ts's own note on this - same
// posture, `init()` never waits on the round trip, resolved once per
// document rather than on a later settings change, and against this
// script's own copy of `lib/i18n/index.js` (a separate build from that
// script's, no shared module graph between the two).
if (claimDocument('linkedin-post-assist')) {
  init();
  void resolvePanelLocale().then(setLocale);
}
