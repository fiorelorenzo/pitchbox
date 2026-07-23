import { parseBackendUrl, parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { logFromContent } from '../lib/log-from-content.js';

// Auto-attribution for the reddit-poster scenario. Runs on the submit page
// (www.reddit.com/r/*/submit* and old.reddit.com's equivalent). We never click
// submit for the user - we observe Reddit's own redirect to /comments/<t3>
// after they hit its button and POST /sent with that t3 so the reply poller
// can pick up future comments.
//
// This works when the redirect keeps this script's context alive, i.e.
// www.reddit.com's SPA routing. On old.reddit.com the submit is a classic
// full-page POST that tears down this context before the URL poll can observe
// the change, so the t3 is not auto-detected there; that give-up is LOGGED
// (submit-poll-timeout) and the draft is completed via the dashboard's manual
// "Mark as sent". We deliberately do NOT try to re-attribute across a hard
// navigation by keying off "the next /comments/ page this tab happens to
// load": that risks marking the draft sent with an unrelated post's id, which
// is worse than leaving it for manual completion.

// Match /r/<sub>/comments/<id>/<slug>/ - the id after /comments/ is the t3.
// Exported and pure so it can be unit-tested without a live browser (#205).
export function extractT3(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/comments\/([a-z0-9]{4,12})(?:\/|$)/i);
    return m ? `t3_${m[1]}` : null;
  } catch {
    return null;
  }
}

async function sendSubmitted(
  draftId: number,
  backendUrl: string | undefined,
  t3: string,
): Promise<void> {
  const res = await api.sent(draftId, undefined, undefined, t3, undefined, backendUrl);
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

// Reddit's submit-page button says "Post" on the new UI; old.reddit.com's
// classic form typically has a plain type="submit" button. Kept local (rather
// than in shared/reddit-dom.ts) since it is submit-page specific and untested
// against live markup - see the module doc comment.
function findPostSubmitButton(): HTMLButtonElement | null {
  const direct = document.querySelector('button[type="submit"]');
  if (direct) return direct as HTMLButtonElement;
  return (
    (Array.from(document.querySelectorAll('button')).find((b) =>
      /^(post|submit)$/i.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

const draftId = parseDraftId(location.href);
const backendUrl = parseBackendUrl(location.href) ?? undefined;

if (draftId !== null) {
  let armed = false;
  let sent = false;

  // (#204) Send the intermediate 'armed' signal on click, mirroring
  // post-comment.ts's onSendIntent so the draft timeline shows "Send clicked".
  async function onArm() {
    if (armed) return;
    armed = true;
    await api.armed(draftId!, backendUrl);
  }

  async function onSubmitted(t3: string) {
    if (sent) return;
    sent = true;
    await sendSubmitted(draftId!, backendUrl, t3);
  }

  function wireSubmit(): boolean {
    const btn = findPostSubmitButton();
    if (!btn) return false;
    btn.addEventListener('click', () => void onArm(), { capture: true });
    return true;
  }

  if (!wireSubmit()) {
    const obs = new MutationObserver(() => {
      if (wireSubmit()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => {
      obs.disconnect();
      // (#173) Give-up path: the submit button never appeared, so 'armed' was
      // never sent. The URL poll below is independent and still runs.
      logFromContent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.submit-button-not-found',
        meta: { draftId },
      });
    }, 15_000);
  }

  // Detect Reddit's redirect to /comments/<t3> within this same script context
  // (works on www.reddit.com's SPA routing; old.reddit.com's hard navigation
  // tears this down, so the t3 is not detected there and the give-up below is
  // logged).
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
      // (#173) Navigated away from /submit without a t3 in this context.
      window.clearInterval(poll);
      logFromContent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.submit-no-t3',
        meta: { draftId },
      });
    }
  }, 500);
  window.setTimeout(() => {
    window.clearInterval(poll);
    if (!sent) {
      // (#173) 60s with no redirect observed in this context (e.g.
      // old.reddit.com's hard navigation) - complete manually from the dashboard.
      logFromContent({
        level: 'warn',
        source: 'reddit-action',
        message: 'activity.reddit-action.submit-poll-timeout',
        meta: { draftId },
      });
    }
  }, 60_000);
}
