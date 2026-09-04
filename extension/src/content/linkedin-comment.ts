import { parseBackendUrl, parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import {
  findCommentComposer,
  findCommentSubmitButton,
  queryDeep,
  queryDeepAll,
} from './shared/linkedin-dom.js';

const draftId = parseDraftId(location.href);
const backendUrl = parseBackendUrl(location.href) ?? undefined;

/**
 * Insert `value` into LinkedIn's contenteditable comment composer the way a
 * real keystroke would: write the text into the node itself, then dispatch a
 * genuine `input` event carrying `inputType`/`data` so a framework listening
 * for native input (the way `post-comment.ts`'s `setValueCompat` does for
 * Reddit's own contenteditable box) has something to react to. Never assigns
 * `.value` - there is none on a contenteditable node.
 *
 * Unverified against a live signed-in LinkedIn session (none is available in
 * this environment - see `linkedin-dom.ts`'s header and
 * docs/linkedin-integration-design.md). `wireComposerInsert` below always
 * copies the same text to the clipboard alongside this call, so a silent
 * miss here (the framework not recognising a JS-dispatched event) still
 * leaves the human a real native paste - indistinguishable to LinkedIn's own
 * editor from typing - as a working path. See the PR for the reasoning.
 */
export function insertComposerText(el: HTMLElement, value: string): void {
  el.textContent = value;
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
  );
}

/**
 * Best-effort clipboard copy, the fallback half of `insertComposerText`
 * above. Wrapped defensively: `navigator.clipboard` can be undefined outside
 * a secure context and `writeText` can reject without a live user gesture,
 * neither of which should block the (already-attempted) direct insertion.
 */
async function copyDraftToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText?.(value);
  } catch {
    // ignore - the direct insertion attempt above is still worth having tried
  }
}

/**
 * True when a visible inline error/validation banner is present near the
 * comment composer. Mirrors `post-comment.ts`'s `hasInlineCommentError` for
 * Reddit: broad and conservative on purpose, since a false positive only
 * costs an extra wait until the give-up timeout, while a false negative
 * would silently mark a failed comment as sent. Unverified against a live
 * capture - neither fixture in `extension/tests/content/fixtures/linkedin/`
 * shows a rejected submission - so this reads the one attribute LinkedIn's
 * own markup already uses elsewhere for a11y alerts (`role="alert"`), the
 * same primary signal `hasInlineCommentError` checks for new Reddit.
 */
export function hasInlineCommentError(root: ParentNode = document): boolean {
  const alert = queryDeep('[role="alert"]', root);
  return !!alert?.textContent?.trim();
}

/** Every comment URN (`article[data-id]`) currently rendered under `root`. */
function snapshotCommentIds(root: ParentNode = document): Set<string> {
  const ids = new Set<string>();
  for (const article of queryDeepAll<HTMLElement>('article[data-id]', root)) {
    const id = article.getAttribute('data-id');
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The URN of a comment article that (a) was not present in `baselineIds`
 * (captured right before the human's submit click) and (b) contains
 * `sentText`. Requiring both, rather than either alone, is deliberate: a
 * text match alone could hit an older comment that happens to repeat our
 * words, and a "new node appeared" signal alone is exactly the heuristic
 * #181 dropped for Reddit (a busy thread's own live updates can add nodes
 * unrelated to this submission). Exported for unit testing.
 */
export function findOurCommentUrn(
  sentText: string,
  baselineIds: ReadonlySet<string>,
  root: ParentNode = document,
): string | undefined {
  const target = sentText.replace(/\s+/g, ' ').trim();
  if (!target) return undefined;
  for (const article of queryDeepAll<HTMLElement>('article[data-id]', root)) {
    const id = article.getAttribute('data-id');
    if (!id || baselineIds.has(id)) continue;
    const text = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.includes(target)) return id;
  }
  return undefined;
}

if (draftId !== null) {
  let armed = false;
  let sent = false;
  let filled = false;
  let draftVersion: number | undefined;

  /**
   * Offer the draft body in the composer, but only once the human has
   * explicitly clicked into it - the compliance boundary
   * (docs/linkedin-integration-design.md, "The compliance boundary") is
   * specific that inserted text follows "an explicit action by the human,
   * and nothing more". Unlike `post-comment.ts`'s `fill()`, which pre-fills
   * Reddit's textarea unconditionally at page load, this listens for (never
   * dispatches) the human's own click on the composer LinkedIn already
   * rendered - no extra UI, matching every other content script in this
   * directory ("only reads and writes fields that LinkedIn or Reddit
   * already put on the page", see `shared/panel-host.ts`'s header for why
   * that stays true here and the in-page assist panel is separate work).
   */
  function wireComposerInsert(composer: HTMLElement, body: string): void {
    composer.addEventListener(
      'click',
      () => {
        if (filled) return;
        // Don't overwrite text the human already typed themselves.
        if (composer.textContent?.trim()) return;
        filled = true;
        insertComposerText(composer, body);
        void copyDraftToClipboard(body);
      },
      { capture: true },
    );
  }

  async function onSendIntent() {
    if (armed) return;
    armed = true;
    await api.armed(draftId!, backendUrl);
  }

  async function onSendCompleted(sentContent: string, platformPostId: string) {
    if (sent) return;
    sent = true;
    const res = await api.sent(
      draftId!,
      sentContent || undefined,
      undefined,
      platformPostId,
      draftVersion,
      backendUrl,
    );
    if (res.ok) {
      logFromContent({
        level: 'info',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.comment-sent',
        messageParams: { draftId: draftId! },
        meta: { draftId },
      });
    } else {
      logFromContent({
        level: 'error',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.fail',
        messageParams: { draftId: draftId!, reason: res.error || String(res.status) },
        meta: {
          draftId,
          script: 'linkedin-comment',
          reason: res.error || String(res.status),
          status: res.status,
          url: location.href,
        },
      });
    }
  }

  /**
   * Wires LinkedIn's own submit control. Listens for the human's click
   * (never dispatches one - see the module doc comment above) to arm the
   * draft, then polls for completion the same shape
   * `post-comment.ts`'s `wireSubmit` uses for Reddit: composer cleared, a
   * new comment node carrying our text, and no inline error banner, all
   * three required before flipping the draft to sent; a 20s give-up window
   * if none of that resolves.
   */
  function wireSubmit(): boolean {
    const btn = findCommentSubmitButton();
    if (!btn) return false;
    btn.addEventListener(
      'click',
      () => {
        void onSendIntent();
        // Captured now, before submit clears the composer - unlike
        // Reddit's post-comment.ts, which only reads the (by-then-empty)
        // box after detecting completion and relies on the server's
        // draft.body fallback instead.
        const sentContentSnapshot = findCommentComposer()?.textContent?.trim() ?? '';
        const baselineIds = snapshotCommentIds();
        const poll = window.setInterval(() => {
          const composer = findCommentComposer();
          const cleared = !composer || !composer.textContent?.trim();
          if (!cleared || hasInlineCommentError()) return;
          const urn = findOurCommentUrn(sentContentSnapshot, baselineIds);
          if (!urn) return;
          clearInterval(poll);
          void onSendCompleted(sentContentSnapshot, urn);
        }, 500);
        window.setTimeout(() => {
          clearInterval(poll);
          if (!sent) {
            logFromContent({
              level: 'error',
              source: 'linkedin-action',
              message: 'activity.linkedin-action.comment-confirm-timeout',
              messageParams: { draftId: draftId! },
              meta: {
                draftId,
                script: 'linkedin-comment',
                step: 'confirm-send',
                reason: 'click-poll-timeout',
                url: location.href,
              },
            });
          }
        }, 20_000);
      },
      { capture: true },
    );
    return true;
  }

  async function init() {
    const r = await api.getDraft(draftId!, backendUrl);
    if (!r.ok) return;
    draftVersion = r.data.version;
    const composer = findCommentComposer();
    if (!composer) {
      // #173-equivalent for LinkedIn: give up visibly instead of leaving the
      // draft silently unofferable with no trace in the activity log.
      logFromContent({
        level: 'warn',
        source: 'linkedin-action',
        message: 'activity.linkedin-action.composer-missing',
        messageParams: { draftId: draftId! },
        meta: {
          draftId,
          script: 'linkedin-comment',
          step: 'offer',
          selector: 'findCommentComposer',
          reason: 'comment-composer-not-found',
          url: location.href,
        },
      });
    } else {
      wireComposerInsert(composer, r.data.body);
    }
    if (!wireSubmit()) {
      // The submit control legitimately does not exist until the composer
      // has text (see linkedin-dom.ts's `findCommentSubmitButton` doc
      // comment), so this is the expected path, not a fallback - wait for
      // it to appear, whether from our insert or the human's own typing.
      let wired = false;
      const obs = new MutationObserver(() => {
        if (wireSubmit()) {
          wired = true;
          obs.disconnect();
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(() => {
        obs.disconnect();
        if (!wired) {
          logFromContent({
            level: 'warn',
            source: 'linkedin-action',
            message: 'activity.linkedin-action.comment-submit-not-found',
            messageParams: { draftId: draftId! },
            meta: {
              draftId,
              script: 'linkedin-comment',
              step: 'wire-submit-button',
              selector: 'findCommentSubmitButton',
              reason: 'submit-button-not-found',
              url: location.href,
            },
          });
        }
      }, 15_000);
    }
  }

  void init();
}
