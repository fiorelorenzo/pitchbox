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

  // #206/#246: auto-fill the compose textarea from the draft, mirroring
  // post-comment.ts's fill(). Not a give-up path for sending itself (nothing
  // was armed yet) - the user still has the manual copy-paste fallback -
  // but a markup change here must still be discoverable instead of a
  // silent no-op with no trace in the activity log.
  async function fill() {
    const r = await api.getDraft(draftId!, backendUrl);
    if (!r.ok) return;
    const el = findComposeTextarea();
    if (!el) {
      logFromContent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.compose-box-missing',
        messageParams: { draftId: draftId! },
        meta: {
          draftId,
          script: 'dm-compose',
          step: 'fill',
          selector: 'findComposeTextarea',
          url: location.href,
        },
      });
      return;
    }
    // Don't overwrite text the user already typed.
    if (el.value) return;
    setTextareaValue(el, r.data.body);
  }

  async function onSendIntent() {
    if (armed) return;
    armed = true;
    // Capture the textarea content at click time - Reddit clears it on success.
    const el = findComposeTextarea();
    if (el) {
      capturedBody = el.value || undefined;
    } else {
      capturedBody = undefined;
      // #246: the send button was found (wireUp already succeeded) but the
      // compose box is gone by click time - log it instead of silently
      // sending no captured body to the backend.
      logFromContent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.compose-box-missing',
        messageParams: { draftId: draftId! },
        meta: {
          draftId,
          script: 'dm-compose',
          step: 'capture-on-send-intent',
          selector: 'findComposeTextarea',
          url: location.href,
        },
      });
    }
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
        messageParams: { draftId: draftId! },
        meta: { draftId },
      });
    } else {
      logFromContent({
        level: 'error',
        source: 'reddit-action',
        message: 'activity.reddit-action.fail',
        messageParams: { draftId: draftId!, reason: res.error || String(res.status) },
        meta: {
          draftId,
          script: 'dm-compose',
          reason: res.error || String(res.status),
          status: res.status,
          url: location.href,
        },
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
            messageParams: { draftId: draftId! },
            meta: { draftId, script: 'dm-compose', step: 'confirm-send', url: location.href },
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
          messageParams: { draftId: draftId! },
          meta: {
            draftId,
            script: 'dm-compose',
            step: 'wire-send-button',
            selector: 'findComposeSendButton',
            url: location.href,
          },
        });
      }, 15_000);
    }
  }

  void init();
}
