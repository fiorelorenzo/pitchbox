import { describe, expect, it } from 'vitest';
import { mapMastodonSendParams } from '../../../src/draft-send.js';

// Covers the pure draft.kind -> Mastodon postStatus params mapping (MAS-5):
// dm -> direct-visibility status mentioning the target; post_comment /
// comment_reply -> a reply (in_reply_to_id from platformCommentId); post -> a
// public status. No network/DB - pure function.
describe('mapMastodonSendParams', () => {
  it('maps a dm draft to a direct-visibility status mentioning the target', () => {
    const params = mapMastodonSendParams({
      kind: 'dm',
      body: 'Hey, loved your post about self-hosting!',
      targetUser: 'alice@mastodon.social',
      platformCommentId: null,
    });
    expect(params.visibility).toBe('direct');
    expect(params.status).toBe('@alice@mastodon.social Hey, loved your post about self-hosting!');
    expect(params.inReplyToId).toBeUndefined();
  });

  it('does not double-mention a dm draft whose body already mentions the target', () => {
    const params = mapMastodonSendParams({
      kind: 'dm',
      body: '@alice@mastodon.social already mentioned here',
      targetUser: 'alice@mastodon.social',
      platformCommentId: null,
    });
    expect(params.status).toBe('@alice@mastodon.social already mentioned here');
  });

  it('maps a dm draft with no targetUser to a plain direct status', () => {
    const params = mapMastodonSendParams({
      kind: 'dm',
      body: 'hello',
      targetUser: null,
      platformCommentId: null,
    });
    expect(params.visibility).toBe('direct');
    expect(params.status).toBe('hello');
  });

  it('maps a post_comment draft to a public reply using platformCommentId as in_reply_to_id', () => {
    const params = mapMastodonSendParams({
      kind: 'post_comment',
      body: 'Great point, we ran into the same thing.',
      targetUser: 'bob@fosstodon.org',
      platformCommentId: '112233',
    });
    expect(params.visibility).toBe('public');
    expect(params.inReplyToId).toBe('112233');
    expect(params.status).toBe('Great point, we ran into the same thing.');
  });

  it('maps a comment_reply draft the same way as post_comment', () => {
    const params = mapMastodonSendParams({
      kind: 'comment_reply',
      body: 'Following up on your reply.',
      targetUser: 'bob@fosstodon.org',
      platformCommentId: '445566',
    });
    expect(params.visibility).toBe('public');
    expect(params.inReplyToId).toBe('445566');
  });

  it('omits in_reply_to_id for a post_comment draft with no platformCommentId', () => {
    const params = mapMastodonSendParams({
      kind: 'post_comment',
      body: 'text',
      targetUser: null,
      platformCommentId: null,
    });
    expect(params.inReplyToId).toBeUndefined();
  });

  it('maps a post draft to a public top-level status', () => {
    const params = mapMastodonSendParams({
      kind: 'post',
      body: 'Launching a self-hosted outreach agent for Reddit and HN #buildinpublic',
      targetUser: null,
      platformCommentId: null,
    });
    expect(params.visibility).toBe('public');
    expect(params.inReplyToId).toBeUndefined();
    expect(params.status).toBe(
      'Launching a self-hosted outreach agent for Reddit and HN #buildinpublic',
    );
  });
});
