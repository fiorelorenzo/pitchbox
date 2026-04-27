import { parseDraftId } from '../lib/draft-param.js';
import { api } from '../lib/api.js';
import { findCommentTextarea, findCommentSubmitButton } from './shared/reddit-dom.js';

const draftId = parseDraftId(location.href);

function derivePostId(pathname: string): string | null {
  // /r/<sub>/comments/<postId>/<slug>/...   — Reddit's canonical pattern.
  const m = /\/comments\/([a-z0-9]+)\b/i.exec(pathname);
  return m ? m[1] : null;
}

async function fetchAccountHandle(draftId: number): Promise<string | null> {
  // Reddit-issued cookies authenticate /api/me.json — works uniformly on old and
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

  function setValueCompat(el: HTMLTextAreaElement | HTMLElement, value: string) {
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

  function readCurrentText(): string | undefined {
    const el = findCommentTextarea();
    if (!el) return undefined;
    if (el instanceof HTMLTextAreaElement) return el.value || undefined;
    return el.textContent?.trim() || undefined;
  }

  async function fill() {
    const r = await api.getDraft(draftId!);
    if (!r.ok) return;
    const el = findCommentTextarea();
    if (!el) return;
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
    await api.armed(draftId!);
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
    await api.sent(draftId!, sentContent, commentLookup);
  }

  function wireSubmit(): boolean {
    const btn = findCommentSubmitButton();
    if (!btn) return false;
    btn.addEventListener(
      'click',
      () => {
        void onSendIntent();
        const startCount = document.querySelectorAll('[data-testid^="comment"]').length;
        const poll = window.setInterval(() => {
          const now = document.querySelectorAll('[data-testid^="comment"]').length;
          const el = findCommentTextarea();
          const cleared =
            (el instanceof HTMLTextAreaElement && !el.value) ||
            (el && !(el instanceof HTMLTextAreaElement) && !el.textContent?.trim());
          if (now > startCount || cleared) {
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

  async function init() {
    await fill();
    if (!wireSubmit()) {
      const obs = new MutationObserver(() => {
        if (wireSubmit()) obs.disconnect();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(() => obs.disconnect(), 15_000);
    }
  }

  void init();
}
