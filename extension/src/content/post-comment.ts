import { parseBackendUrl, parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import { findCommentTextarea, findCommentSubmitButton, queryDeep } from './shared/reddit-dom.js';

const draftId = parseDraftId(location.href);
const backendUrl = parseBackendUrl(location.href) ?? undefined;

// /r/<sub>/comments/<postId>/<slug>/...   - Reddit's canonical pattern.
// Exported (pure, no DOM/network access) so it is unit-testable on its own (#205).
export function derivePostId(pathname: string): string | null {
  const m = /\/comments\/([a-z0-9]+)\b/i.exec(pathname);
  return m ? m[1] : null;
}

/**
 * Set a textarea's (or a contenteditable's) value the way a real keystroke
 * would: go through the native value setter and dispatch a genuine `input`
 * event, rather than assigning `.value`/`.textContent` directly, which
 * leaves Reddit's React-controlled inputs unaware the value changed and
 * lets React revert it on the next render.
 * Exported (only touches the node it is given, no globals) so it is
 * unit-testable on its own (#205).
 */
export function setValueCompat(el: HTMLTextAreaElement | HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
}

/**
 * True when a visible inline error/validation banner is present near the
 * comment form. On its own, "the textarea went empty" is not proof a comment
 * actually posted (#181): Reddit can still clear the compose box on a
 * rate-limited, auto-filtered, or otherwise rejected submission. There is no
 * live Reddit session available here to confirm the exact error markup
 * against, so this check is intentionally broad and conservative: any
 * visible `role="alert"` element (new Reddit) or non-empty legacy `.error`
 * element (old Reddit) counts as "something went wrong", even if it turns
 * out unrelated to this particular submission. A false positive here only
 * costs an extra wait until the give-up timeout below fires; a false
 * negative would silently mark a failed post as sent, so this deliberately
 * biases toward the former.
 */
export function hasInlineCommentError(root: ParentNode = document): boolean {
  // Pierce shadow DOM: on www.reddit.com the inline rejection banner can render
  // inside a shreddit-* shadow root, which a plain querySelector can't see - a
  // blind spot that would let a genuinely-failed comment pass the success check.
  const alert = queryDeep('[role="alert"]', root);
  if (alert?.textContent?.trim()) return true;
  const legacy = queryDeep('.error', root);
  return !!legacy?.textContent?.trim();
}

async function fetchAccountHandle(draftId: number): Promise<string | null> {
  // Reddit-issued cookies authenticate /api/me.json - works uniformly on old and
  // new Reddit, regardless of which user link happens to be first in the DOM
  // (often the post author, not the logged-in user).
  void draftId;
  try {
    const res = await fetch('https://www.reddit.com/api/me.json?raw_json=1', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { name?: string } };
      const name = data?.data?.name;
      if (name) return name;
    }
  } catch {
    // ignore, fall through to DOM heuristics
  }
  const meta = document.querySelector('meta[name="user-name"]');
  const fromMeta = meta?.getAttribute('content');
  if (fromMeta) return fromMeta;
  const userLink = document.querySelector('a[href^="/user/"]');
  const href = userLink?.getAttribute('href') ?? '';
  const m = /^\/user\/([^/]+)/.exec(href);
  return m ? m[1] : null;
}

if (draftId !== null) {
  let armed = false;
  let sent = false;

  function readCurrentText(): string | undefined {
    const el = findCommentTextarea();
    if (!el) return undefined;
    if (el instanceof HTMLTextAreaElement) return el.value || undefined;
    return el.textContent?.trim() || undefined;
  }

  async function fill() {
    const r = await api.getDraft(draftId!, backendUrl);
    if (!r.ok) return;
    const el = findCommentTextarea();
    if (!el) {
      // #173: give up visibly instead of leaving the draft silently
      // unfilled with no trace in the activity log.
      logFromContent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.comment-box-missing',
        messageParams: { draftId: draftId! },
        meta: { draftId, reason: 'comment-textarea-not-found' },
      });
      return;
    }
    // Don't overwrite text the user already typed.
    if (
      (el instanceof HTMLTextAreaElement && el.value) ||
      (!(el instanceof HTMLTextAreaElement) && el.textContent?.trim())
    ) {
      return;
    }
    setValueCompat(el, r.data.body);
  }

  async function onSendIntent() {
    if (armed) return;
    armed = true;
    await api.armed(draftId!, backendUrl);
  }

  async function onSendCompleted() {
    if (sent) return;
    sent = true;
    const sentContent = readCurrentText();
    const postId = derivePostId(location.pathname);
    const handle = await fetchAccountHandle(draftId!);
    const commentLookup =
      postId && handle
        ? { postId, accountHandle: handle, postedAt: new Date().toISOString() }
        : undefined;
    const res = await api.sent(
      draftId!,
      sentContent,
      commentLookup,
      undefined,
      undefined,
      backendUrl,
    );
    if (res.ok) {
      logFromContent({
        level: 'info',
        source: 'reddit-action',
        message: 'activity.reddit-action.comment-sent',
        messageParams: { draftId: draftId! },
        meta: { draftId },
      });
    } else {
      logFromContent({
        level: 'error',
        source: 'reddit-action',
        message: 'activity.reddit-action.fail',
        messageParams: { draftId: draftId!, reason: res.error || String(res.status) },
        meta: { draftId, reason: res.error || String(res.status), status: res.status },
      });
    }
  }

  function wireSubmit(): boolean {
    const btn = findCommentSubmitButton();
    if (!btn) return false;
    btn.addEventListener(
      'click',
      () => {
        void onSendIntent();
        // #181: this used to also treat a rising
        // `[data-testid^="comment"]` count as proof of success. On a
        // busy/live-updating thread that count can grow for reasons
        // unrelated to this submission (someone else's comment, a
        // live-update re-render), so a comment that actually FAILED
        // (auto-filter, rate limit, validation rejection) could still fire
        // onSendCompleted and flip the draft to sent with nothing really
        // posted. Rely only on the textarea clearing, and only when no
        // inline error banner is visible - see hasInlineCommentError above.
        const poll = window.setInterval(() => {
          const el = findCommentTextarea();
          const cleared =
            (el instanceof HTMLTextAreaElement && !el.value) ||
            (!!el && !(el instanceof HTMLTextAreaElement) && !el.textContent?.trim());
          if (cleared && !hasInlineCommentError()) {
            clearInterval(poll);
            void onSendCompleted();
          }
        }, 500);
        window.setTimeout(() => {
          clearInterval(poll);
          if (!sent) {
            // #173: the click happened (armed was already recorded) but we
            // never confirmed the comment actually posted within the
            // window - give up visibly rather than leaving the draft
            // silently stuck armed.
            logFromContent({
              level: 'error',
              source: 'reddit-action',
              message: 'activity.reddit-action.comment-confirm-timeout',
              messageParams: { draftId: draftId! },
              meta: { draftId, reason: 'click-poll-timeout' },
            });
          }
        }, 20_000);
      },
      { capture: true },
    );
    return true;
  }

  async function init() {
    await fill();
    if (!wireSubmit()) {
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
          // #173: never found a submit button to wire up within the
          // window - give up visibly instead of leaving the page silently
          // unwired with no way to tell from the activity log.
          logFromContent({
            level: 'warn',
            source: 'reddit-action',
            message: 'activity.reddit-action.comment-submit-not-found',
            messageParams: { draftId: draftId! },
            meta: { draftId, reason: 'submit-button-not-found' },
          });
        }
      }, 15_000);
    }
  }

  void init();
}
