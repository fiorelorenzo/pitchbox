import { parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { findComposeTextarea, findComposeSendButton } from './shared/reddit-dom.js';

const draftId = parseDraftId(location.href);

if (draftId !== null) {
  let armed = false;
  let sent = false;
  let capturedBody: string | undefined;

  async function onSendIntent() {
    if (armed) return;
    armed = true;
    // Capture the textarea content at click time — Reddit clears it on success.
    capturedBody = findComposeTextarea()?.value || undefined;
    await api.armed(draftId!);
  }

  async function onSendCompleted() {
    if (sent) return;
    sent = true;
    await api.sent(draftId!, capturedBody);
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
