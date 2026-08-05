import { registerPresenter, type Presenter, type DraftLike } from '../presenter';

function subredditOf(d: DraftLike): string | null {
  const md = d.metadata as { subreddit?: unknown } | null;
  return typeof md?.subreddit === 'string' ? md.subreddit : null;
}

// Honest, punctuation-free fallback when neither a subreddit nor a recipient
// is available. Kept per-kind so the label still says something about what
// the draft is, instead of a bare "Reddit".
function fallbackLabel(kind: string): string {
  switch (kind) {
    case 'dm':
      return 'Reddit DM';
    case 'post':
      return 'Reddit post';
    case 'post_comment':
      return 'Reddit comment';
    case 'comment_reply':
      return 'Reddit reply';
    default:
      return 'Reddit draft';
  }
}

export const redditPresenter: Presenter = {
  primaryLabel(d) {
    if (d.kind === 'dm') {
      return d.targetUser ? `u/${d.targetUser}` : fallbackLabel(d.kind);
    }
    const subreddit = subredditOf(d);
    if (subreddit) return `r/${subreddit}`;
    if (d.targetUser) {
      // Non-dm drafts are expected to carry a subreddit (see issue #236); one
      // that reaches here without one is a data bug, not just a display gap.
      // Falling back to the recipient hides it from the UI on purpose, so
      // surface it to developers instead.
      if (import.meta.env.DEV) {
        console.warn(
          `[reddit presenter] draft kind "${d.kind}" has no subreddit, falling back to recipient u/${d.targetUser}`,
        );
      }
      return `u/${d.targetUser}`;
    }
    return fallbackLabel(d.kind);
  },
  userLabel: (handle) => `u/${handle}`,
  eventLabel(event) {
    return event === 'armed' ? 'Send clicked on Reddit' : null;
  },
  replyActionLabel: () => 'Reply on Reddit',
};

registerPresenter('reddit', redditPresenter);
