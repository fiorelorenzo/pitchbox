import { registerPresenter, type Presenter, type DraftLike } from '../presenter';

function storyIdOf(d: DraftLike): string | null {
  const md = d.metadata as { itemId?: unknown; storyId?: unknown } | null;
  const raw = md?.itemId ?? md?.storyId;
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return null;
}

export const hackernewsPresenter: Presenter = {
  primaryLabel(d) {
    // HN has no DMs - every draft is a comment on a story.
    const id = storyIdOf(d);
    return id ? `HN #${id}` : 'HN story';
  },
  userLabel: (handle) => handle,
  eventLabel(event) {
    return event === 'armed' ? 'Send clicked on Hacker News' : null;
  },
  replyActionLabel: () => 'Reply on Hacker News',
};

registerPresenter('hackernews', hackernewsPresenter);
