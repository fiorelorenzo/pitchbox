import { registerPresenter, type Presenter, type DraftLike } from '../presenter';
import { t } from '$lib/i18n/index.js';

function storyIdOf(d: DraftLike): string | null {
  const md = d.metadata as { itemId?: unknown; storyId?: unknown } | null;
  const raw = md?.itemId ?? md?.storyId;
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return null;
}

export const hackernewsPresenter: Presenter = {
  primaryLabel(locale, d) {
    // HN has no DMs - every draft is a comment on a story.
    const id = storyIdOf(d);
    return id ? `HN #${id}` : t(locale, 'presenter.hackernews.story-fallback');
  },
  userLabel: (handle) => handle,
  eventLabel(locale, event) {
    return event === 'armed' ? t(locale, 'presenter.hackernews.event-armed') : null;
  },
  replyActionLabel: (locale) => t(locale, 'presenter.hackernews.reply-action'),
};

registerPresenter('hackernews', hackernewsPresenter);
