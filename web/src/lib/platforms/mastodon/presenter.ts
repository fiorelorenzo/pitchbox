import { registerPresenter, type Presenter } from '../presenter';
import { t } from '$lib/i18n/index.js';

export const mastodonPresenter: Presenter = {
  primaryLabel(locale, d) {
    // Mastodon has no self-standing target for a top-level "post" (toot);
    // dm/comment always carry a targetUser (fully qualified "@user@instance").
    return d.targetUser ? d.targetUser : t(locale, 'presenter.mastodon.post-fallback');
  },
  // Mastodon handles are already fully qualified ("@user@instance") - avoid
  // double-prefixing with another "@" the way the generic presenter does.
  userLabel: (handle) => (handle.startsWith('@') ? handle : `@${handle}`),
  eventLabel(locale, event) {
    return event === 'armed' ? t(locale, 'presenter.mastodon.event-armed') : null;
  },
  replyActionLabel: (locale) => t(locale, 'presenter.mastodon.reply-action'),
};

registerPresenter('mastodon', mastodonPresenter);
