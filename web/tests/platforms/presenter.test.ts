import { describe, it, expect } from 'vitest';
import { getPresenter, isExtensionAutomated } from '../../src/lib/platforms/presenter';
import '../../src/lib/platforms/reddit/presenter';
import '../../src/lib/platforms/mastodon/presenter';
import '../../src/lib/platforms/linkedin/presenter';

describe('presenter registry', () => {
  it('returns Reddit presenter with r/ and u/ semantics', () => {
    const p = getPresenter('reddit');
    expect(p.primaryLabel({ kind: 'dm', targetUser: 'bob', metadata: {} })).toBe('u/bob');
    expect(
      p.primaryLabel({
        kind: 'post_comment',
        targetUser: null,
        metadata: { subreddit: 'rpg' },
      }),
    ).toBe('r/rpg');
    expect(p.userLabel('alice')).toBe('u/alice');
    expect(p.eventLabel('armed')).toBe('Send clicked on Reddit');
  });

  // The reply drafter's kinds are `reply_dm` / `reply_comment`, not `dm` /
  // `comment_reply`. Matching only the latter put every reply-DM into the
  // branch that expects a subreddit, so a perfectly healthy draft was treated
  // as a data bug (#258).
  it('treats a reply DM as DM-shaped, with no subreddit expected', () => {
    const p = getPresenter('reddit');
    expect(p.primaryLabel({ kind: 'reply_dm', targetUser: 'bob', metadata: {} })).toBe('u/bob');
    expect(p.primaryLabel({ kind: 'reply_dm', targetUser: null, metadata: {} })).toBe(
      'Reddit DM reply',
    );
  });

  it('names a comment reply by its subreddit, since it lives in one', () => {
    const p = getPresenter('reddit');
    expect(
      p.primaryLabel({
        kind: 'reply_comment',
        targetUser: 'bob',
        metadata: { subreddit: 'selfhosted' },
      }),
    ).toBe('r/selfhosted');
    expect(p.primaryLabel({ kind: 'reply_comment', targetUser: null, metadata: {} })).toBe(
      'Reddit reply',
    );
  });

  it('returns Mastodon presenter with fully-qualified-handle semantics', () => {
    const p = getPresenter('mastodon');
    expect(p.primaryLabel({ kind: 'dm', targetUser: 'alice@fosstodon.org', metadata: {} })).toBe(
      'alice@fosstodon.org',
    );
    expect(p.primaryLabel({ kind: 'post', targetUser: null, metadata: {} })).toBe('Mastodon post');
    // Handles are already fully qualified - no double "@" prefixing.
    expect(p.userLabel('@bot@mastodon.example')).toBe('@bot@mastodon.example');
    expect(p.userLabel('bot@mastodon.example')).toBe('@bot@mastodon.example');
    expect(p.eventLabel('armed')).toBe('Send clicked on Mastodon');
  });

  it('returns LinkedIn presenter with the vanity slug rendered as a profile path, not @handle', () => {
    const p = getPresenter('linkedin');
    expect(p.primaryLabel({ kind: 'post_comment', targetUser: 'jane-doe', metadata: {} })).toBe(
      'linkedin.com/in/jane-doe',
    );
    expect(p.primaryLabel({ kind: 'comment_reply', targetUser: 'jane-doe', metadata: {} })).toBe(
      'linkedin.com/in/jane-doe',
    );
    expect(p.primaryLabel({ kind: 'post', targetUser: null, metadata: {} })).toBe('LinkedIn post');
    expect(p.userLabel('jane-doe')).toBe('linkedin.com/in/jane-doe');
    expect(p.eventLabel('armed')).toBe('Send clicked on LinkedIn');
  });

  it('falls back to a generic presenter for unknown slugs', () => {
    const p = getPresenter('mystery');
    expect(p.primaryLabel({ kind: 'dm', targetUser: 'bob', metadata: {} })).toBe('@bob');
    expect(p.userLabel('alice')).toBe('@alice');
    expect(p.eventLabel('armed')).toBeNull();
  });
});

describe('isExtensionAutomated', () => {
  it('is true for reddit and linkedin, the platforms with a matching content script', () => {
    expect(isExtensionAutomated('reddit')).toBe(true);
    expect(isExtensionAutomated('linkedin')).toBe(true);
  });

  it('is false for platforms without a content script (manual send)', () => {
    expect(isExtensionAutomated('hackernews')).toBe(false);
    expect(isExtensionAutomated('mastodon')).toBe(false);
    expect(isExtensionAutomated('mystery')).toBe(false);
  });

  it('is false for a null or undefined slug', () => {
    expect(isExtensionAutomated(null)).toBe(false);
    expect(isExtensionAutomated(undefined)).toBe(false);
  });
});
