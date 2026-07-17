import { registerPresenter, type Presenter } from '../presenter';

export const mastodonPresenter: Presenter = {
  primaryLabel(d) {
    // Mastodon has no self-standing target for a top-level "post" (toot);
    // dm/comment always carry a targetUser (fully qualified "@user@instance").
    return d.targetUser ? d.targetUser : 'Mastodon post';
  },
  // Mastodon handles are already fully qualified ("@user@instance") - avoid
  // double-prefixing with another "@" the way the generic presenter does.
  userLabel: (handle) => (handle.startsWith('@') ? handle : `@${handle}`),
  eventLabel(event) {
    return event === 'armed' ? 'Send clicked on Mastodon' : null;
  },
  replyActionLabel: () => 'Reply on Mastodon',
};

registerPresenter('mastodon', mastodonPresenter);
