import { describe, expect, it } from 'vitest';
import {
  commentTargetSpec,
  indexCandidateAuthors,
  normalizePostId,
  resolveCommentTargetUser,
  COMMENT_TARGET_SPECS,
} from '../src/comment-target.js';

/**
 * Issue #336: a `post_comment` is contact with the post's author, and the
 * author is derived from the run's own staged candidates rather than copied
 * across by the playbook. These are the rules that derivation must not break:
 * it matches only on an identifier the draft itself carries, it refuses an
 * ambiguous match, and it never promotes a display name to a handle.
 */

const reddit = COMMENT_TARGET_SPECS.reddit;
const mastodon = COMMENT_TARGET_SPECS.mastodon;
const linkedin = COMMENT_TARGET_SPECS.linkedin;

describe('normalizePostId', () => {
  it('matches a permalink against the same permalink written as a full URL', () => {
    expect(normalizePostId('https://www.reddit.com/r/rpg/comments/abc/slug/')).toBe(
      normalizePostId('/r/rpg/comments/abc/slug'),
    );
  });

  it('ignores a query string and a fragment, which carry no identity', () => {
    expect(normalizePostId('/r/rpg/comments/abc/slug/?utm_source=x#comment')).toBe(
      normalizePostId('/r/rpg/comments/abc/slug'),
    );
  });

  it('accepts a numeric id, since JSON delivers one as a number', () => {
    expect(normalizePostId(109254)).toBe('109254');
  });

  it('refuses what cannot identify a post', () => {
    expect(normalizePostId('')).toBeNull();
    expect(normalizePostId('   ')).toBeNull();
    expect(normalizePostId(null)).toBeNull();
    expect(normalizePostId({ permalink: '/r/x/1' })).toBeNull();
    expect(normalizePostId('x'.repeat(513))).toBeNull();
  });
});

describe('commentTargetSpec', () => {
  it('has a spec for every platform that stages candidates', () => {
    expect(commentTargetSpec('reddit')).not.toBeNull();
    expect(commentTargetSpec('mastodon')).not.toBeNull();
    expect(commentTargetSpec('linkedin')).not.toBeNull();
  });

  it('has none for Hacker News, which stages nothing to derive from', () => {
    expect(commentTargetSpec('hackernews')).toBeNull();
    expect(commentTargetSpec(null)).toBeNull();
    expect(commentTargetSpec(undefined)).toBeNull();
  });
});

describe('resolveCommentTargetUser', () => {
  it('finds the Reddit post author from the draft permalink', () => {
    const index = indexCandidateAuthors(reddit, [
      { user: { name: 'alice' }, post: { permalink: '/r/rpg/comments/abc/slug/' } },
      { user: { name: 'bob' }, post: { permalink: '/r/rpg/comments/def/other/' } },
    ]);
    expect(
      resolveCommentTargetUser(reddit, index, {
        sourceRef: { permalink: 'https://www.reddit.com/r/rpg/comments/def/other/' },
      }),
    ).toBe('bob');
  });

  it('finds the Mastodon author from either the status id or its URL', () => {
    const index = indexCandidateAuthors(mastodon, [
      {
        author: { acct: 'alice@mastodon.social' },
        status: { id: '109254', url: 'https://mastodon.social/@alice/109254' },
      },
    ]);
    expect(resolveCommentTargetUser(mastodon, index, { sourceRef: { statusId: '109254' } })).toBe(
      'alice@mastodon.social',
    );
    expect(
      resolveCommentTargetUser(mastodon, index, {
        sourceRef: { statusUrl: 'https://mastodon.social/@alice/109254' },
      }),
    ).toBe('alice@mastodon.social');
  });

  it('finds the LinkedIn author from the post URN', () => {
    const index = indexCandidateAuthors(linkedin, [
      {
        author: { handle: 'jane-doe', name: 'Jane Doe' },
        post: {
          externalId: 'urn:li:activity:123',
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
        },
      },
    ]);
    expect(
      resolveCommentTargetUser(linkedin, index, {
        sourceRef: { externalId: 'urn:li:activity:123' },
      }),
    ).toBe('jane-doe');
  });

  it('refuses a display name when the handle is missing, since a name cannot be deduped', () => {
    const index = indexCandidateAuthors(linkedin, [
      {
        author: { handle: null, name: 'Jane Doe' },
        post: { externalId: 'urn:li:activity:123' },
      },
    ]);
    expect(
      resolveCommentTargetUser(linkedin, index, {
        sourceRef: { externalId: 'urn:li:activity:123' },
      }),
    ).toBeNull();
  });

  it('refuses an identifier two candidates disagree about', () => {
    const index = indexCandidateAuthors(reddit, [
      { user: { name: 'alice' }, post: { permalink: '/r/rpg/comments/abc/slug/' } },
      { user: { name: 'bob' }, post: { permalink: '/r/rpg/comments/abc/slug/' } },
    ]);
    expect(
      resolveCommentTargetUser(reddit, index, {
        sourceRef: { permalink: '/r/rpg/comments/abc/slug/' },
      }),
    ).toBeNull();
  });

  it('never guesses: an unmatched or absent identifier yields no target', () => {
    const index = indexCandidateAuthors(reddit, [
      { user: { name: 'alice' }, post: { permalink: '/r/rpg/comments/abc/slug/' } },
    ]);
    expect(
      resolveCommentTargetUser(reddit, index, {
        sourceRef: { permalink: '/r/rpg/comments/zzz/nope/' },
      }),
    ).toBeNull();
    expect(resolveCommentTargetUser(reddit, index, { sourceRef: {}, metadata: {} })).toBeNull();
    expect(resolveCommentTargetUser(reddit, index, {})).toBeNull();
  });

  it('reads the identifier from metadata when the draft put it there', () => {
    const index = indexCandidateAuthors(mastodon, [
      { author: { acct: 'alice@m.example' }, status: { id: '42' } },
    ]);
    expect(resolveCommentTargetUser(mastodon, index, { metadata: { statusId: '42' } })).toBe(
      'alice@m.example',
    );
  });
});
