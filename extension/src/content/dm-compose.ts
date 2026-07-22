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
        const poll = window.setInterval(() => {
          const ta = findComposeTextarea();
          const urlChanged = location.href !== startUrl;
          const textareaGone = !ta;
          const textareaCleared = ta && startText.length > 0 && !ta.value;
          const sendButtonGone = !findComposeSendButton();
          if (urlChanged || textareaGone || textareaCleared || sendButtonGone) {
            clearInterval(poll);
            void onSendCompleted();
          }
        }, 500);
        window.setTimeout(() => clearInterval(poll), 20_000);
      },
      { capture: true },
    );
    return true;
  }

  if (!wireUp()) {
    const obs = new MutationObserver(() => {
      if (wireUp()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => obs.disconnect(), 15_000);
  }
}
