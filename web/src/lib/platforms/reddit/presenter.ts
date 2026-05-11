import { registerPresenter, type Presenter, type DraftLike } from '../presenter';

function subredditOf(d: DraftLike): string | null {
  const md = d.metadata as { subreddit?: unknown } | null;
  return typeof md?.subreddit === 'string' ? md.subreddit : null;
}

export const redditPresenter: Presenter = {
  primaryLabel(d) {
    if (d.kind === 'dm') return `u/${d.targetUser ?? '—'}`;
    return `r/${subredditOf(d) ?? '—'}`;
  },
  userLabel: (handle) => `u/${handle}`,
  eventLabel(event) {
    return event === 'armed' ? 'Send clicked on Reddit' : null;
  },
  replyActionLabel: () => 'Reply on Reddit',
};

registerPresenter('reddit', redditPresenter);
