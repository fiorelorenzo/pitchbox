import { describe, it, expect } from 'vitest';
import { getPresenter, isExtensionAutomated } from '../../src/lib/platforms/presenter';
import '../../src/lib/platforms/reddit/presenter';
import '../../src/lib/platforms/mastodon/presenter';

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

  it('falls back to a generic presenter for unknown slugs', () => {
    const p = getPresenter('mystery');
    expect(p.primaryLabel({ kind: 'dm', targetUser: 'bob', metadata: {} })).toBe('@bob');
    expect(p.userLabel('alice')).toBe('@alice');
    expect(p.eventLabel('armed')).toBeNull();
  });
});

describe('isExtensionAutomated', () => {
  it('is true only for reddit, the one platform with a matching content script', () => {
    expect(isExtensionAutomated('reddit')).toBe(true);
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
