import { registerPresenter, type Presenter } from '../presenter';
import { t } from '$lib/i18n/index.js';

export const linkedinPresenter: Presenter = {
  primaryLabel(locale, d) {
    // Every kind that reaches the presenter carries the connected profile's
    // own targetUser except a bare top-level post, which has no recipient.
    return d.targetUser
      ? `linkedin.com/in/${d.targetUser}`
      : t(locale, 'presenter.linkedin.post-fallback');
  },
  // The handle is the vanity slug LinkedIn puts in a profile URL
  // (linkedin.com/in/<handle>), not a conversational @handle - render it as
  // the profile path instead of prefixing with "@" the way the generic
  // presenter does.
  userLabel: (handle) => `linkedin.com/in/${handle}`,
  eventLabel(locale, event) {
    return event === 'armed' ? t(locale, 'presenter.linkedin.event-armed') : null;
  },
  replyActionLabel: (locale) => t(locale, 'presenter.linkedin.reply-action'),
};

registerPresenter('linkedin', linkedinPresenter);
