import { parseBackendUrl, parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';
import { findComposeTextarea, findComposeSendButton } from './shared/reddit-dom.js';

const draftId = parseDraftId(location.href);
const backendUrl = parseBackendUrl(location.href) ?? undefined;

if (draftId !== null) {
  let armed = false;
  let sent = false;
  let capturedBody: string | undefined;

  // Reddit's DM compose box is a real <textarea>, but new-Reddit wraps it in a
  // React-controlled component: assigning `.value` directly does not stick
  // because React's internal value tracker never observes the change and
  // reverts it on the next render. Going through the native setter descriptor
  // (bypassing the instance's React-patched setter) and then dispatching a
  // real `input` event is the same technique post-comment.ts already ships to
  // production for the comment box, so it is the safe, already-verified
  // choice here too without live-DOM access to re-check new-Reddit's markup.
  function setTextareaValue(el: HTMLTextAreaElement, value: string) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // #206: auto-fill the compose textarea from the draft, mirroring
  // post-comment.ts's fill(). If a future markup change means
  // findComposeTextarea can no longer find the box, this is a silent no-op
  // and the user falls back to the existing copy-paste flow - no error is
  // surfaced for that case since it is not a give-up path (nothing was armed).
  async function fill() {
    const r = await api.getDraft(draftId!, backendUrl);
    if (!r.ok) return;
    const el = findComposeTextarea();
    if (!el) return;
    // Don't overwrite text the user already typed.
    if (el.value) return;
    setTextareaValue(el, r.data.body);
  }

  async function onSendIntent() {
    if (armed) return;
    armed = true;
    // Capture the textarea content at click time - Reddit clears it on success.
    capturedBody = findComposeTextarea()?.value || undefined;
    await api.armed(draftId!, backendUrl);
  }

  async function onSendCompleted() {
    if (sent) return;
    sent = true;
    const res = await api.sent(draftId!, capturedBody, undefined, undefined, undefined, backendUrl);
    if (res.ok) {
      logFromContent({
        level: 'info',
        source: 'reddit-action',
        message: 'activity.reddit-action.dm-sent',
        meta: { draftId },
      });
    } else {
      logFromContent({
        level: 'error',
        source: 'reddit-action',
        message: 'activity.reddit-action.fail',
        meta: { draftId, reason: res.error || String(res.status), status: res.status },
      });
    }
  }

  function wireUp(): boolean {
    const btn = findComposeSendButton();
    if (!btn) return false;
    btn.addEventListener(
      'click',
      () => {
        void onSendIntent();
        const startUrl = location.href;
        const startText = findComposeTextarea()?.value ?? '';
        let detected = false;
        const poll = window.setInterval(() => {
          const ta = findComposeTextarea();
          const urlChanged = location.href !== startUrl;
          const textareaGone = !ta;
          const textareaCleared = ta && startText.length > 0 && !ta.value;
          const sendButtonGone = !findComposeSendButton();
          if (urlChanged || textareaGone || textareaCleared || sendButtonGone) {
            detected = true;
            clearInterval(poll);
            void onSendCompleted();
          }
        }, 500);
        window.setTimeout(() => {
          if (detected) return;
          clearInterval(poll);
          // #173: never give up silently - the click was armed but we never
          // observed a completion signal, so surface it instead of leaving
          // the draft stuck in "armed" with no trace.
          logFromContent({
            level: 'warn',
            source: 'reddit-action',
            message: 'activity.reddit-action.send-poll-timeout',
            meta: { draftId },
          });
        }, 20_000);
      },
      { capture: true },
    );
    return true;
  }

  async function init() {
    await fill();
    if (!wireUp()) {
      let wired = false;
      const obs = new MutationObserver(() => {
        if (wireUp()) {
          wired = true;
          obs.disconnect();
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(() => {
        if (wired) return;
        obs.disconnect();
        // #173: the send button never showed up within the window we watch
        // for it - log it instead of disconnecting quietly.
        logFromContent({
          level: 'warn',
          source: 'reddit-action',
          message: 'activity.reddit-action.send-button-not-found',
          meta: { draftId },
        });
      }, 15_000);
    }
  }

  void init();
}
