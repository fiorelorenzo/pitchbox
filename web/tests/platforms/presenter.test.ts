import { describe, it, expect } from 'vitest';
import { getPresenter } from '../../src/lib/platforms/presenter';
import '../../src/lib/platforms/reddit/presenter';

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

  it('falls back to a generic presenter for unknown slugs', () => {
    const p = getPresenter('mystery');
    expect(p.primaryLabel({ kind: 'dm', targetUser: 'bob', metadata: {} })).toBe('@bob');
    expect(p.userLabel('alice')).toBe('@alice');
    expect(p.eventLabel('armed')).toBeNull();
  });
});
