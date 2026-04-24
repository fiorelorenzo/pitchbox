import { parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { findComposeTextarea, findComposeSendButton } from './shared/reddit-dom.js';

const draftId = parseDraftId(location.href);

if (draftId !== null) {
  let armed = false;
  let sent = false;

  async function onSendIntent() {
    if (armed) return;
    armed = true;
    await api.armed(draftId!);
  }

  async function onSendCompleted() {
    if (sent) return;
    sent = true;
    const body = findComposeTextarea()?.value;
    await api.sent(draftId!, body || undefined);
  }

  function wireUp(): boolean {
    const btn = findComposeSendButton();
    if (!btn) return false;
    btn.addEventListener(
      'click',
      () => {
        void onSendIntent();
        const startUrl = location.href;
        const poll = window.setInterval(() => {
          if (location.href !== startUrl) {
            clearInterval(poll);
            void onSendCompleted();
          }
        }, 400);
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
