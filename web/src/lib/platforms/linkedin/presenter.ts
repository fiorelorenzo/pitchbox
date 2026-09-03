import { registerPresenter, type Presenter } from '../presenter';

export const linkedinPresenter: Presenter = {
  primaryLabel(d) {
    // Every kind that reaches the presenter carries the connected profile's
    // own targetUser except a bare top-level post, which has no recipient.
    return d.targetUser ? `linkedin.com/in/${d.targetUser}` : 'LinkedIn post';
  },
  // The handle is the vanity slug LinkedIn puts in a profile URL
  // (linkedin.com/in/<handle>), not a conversational @handle - render it as
  // the profile path instead of prefixing with "@" the way the generic
  // presenter does.
  userLabel: (handle) => `linkedin.com/in/${handle}`,
  eventLabel(event) {
    return event === 'armed' ? 'Send clicked on LinkedIn' : null;
  },
  replyActionLabel: () => 'Reply on LinkedIn',
};

registerPresenter('linkedin', linkedinPresenter);
