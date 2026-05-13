import { parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';

// Auto-attribution for the reddit-poster scenario. Runs on
// https://www.reddit.com/r/*/submit* and on old.reddit.com's equivalent.
// We never click submit on the user's behalf - we just observe the URL
// change after they hit Reddit's own button and POST /sent with the
// resulting t3_<id> so the reply poller can pick up future comments.

const draftId = parseDraftId(location.href);

if (draftId !== null) {
  let sent = false;

  // Match /r/<sub>/comments/<id>/<slug>/ - Reddit redirects to this after a
  // successful submission. The t3_ id is the segment after /comments/.
  function extractT3(url: string): string | null {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/comments\/([a-z0-9]{4,12})(?:\/|$)/i);
      return m ? `t3_${m[1]}` : null;
    } catch {
      return null;
    }
  }

  async function onSubmitted(t3: string) {
    if (sent) return;
    sent = true;
    const res = await api.sent(draftId!, undefined, undefined, t3);
    if (res.ok) {
      logFromContent({
        level: 'info',
        source: 'reddit-action',
        message: 'activity.reddit-action.submit-sent',
        meta: { draftId, t3 },
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

  const startUrl = location.href;
  let lastUrl = startUrl;
  const poll = window.setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const t3 = extractT3(location.href);
    if (t3) {
      window.clearInterval(poll);
      void onSubmitted(t3);
    } else if (!location.pathname.includes('/submit')) {
      // Navigated away without a t3 - give up cleanly.
      window.clearInterval(poll);
    }
  }, 500);
  window.setTimeout(() => window.clearInterval(poll), 60_000);
}
