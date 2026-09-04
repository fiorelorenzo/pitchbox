import { describe, expect, it } from 'vitest';
import { composeHref } from '../src/lib/utils/compose-url.js';
import { buildRedditComposeUrl } from '@pitchbox/shared/platforms/reddit';

describe('composeHref', () => {
  it('appends the draft id with the right separator', () => {
    expect(composeHref('https://www.reddit.com/message/compose?to=alice', 42)).toBe(
      'https://www.reddit.com/message/compose?to=alice&pitchbox_draft=42',
    );
    expect(composeHref('https://news.ycombinator.com/reply', 7)).toBe(
      'https://news.ycombinator.com/reply?pitchbox_draft=7',
    );
  });

  it('appends the backend origin (encoded) when provided', () => {
    expect(composeHref('https://x.test/c?a=1', 5, 'https://pitchbox.app')).toBe(
      'https://x.test/c?a=1&pitchbox_draft=5&pitchbox_backend=https%3A%2F%2Fpitchbox.app',
    );
  });

  it('omits the backend param when the origin is unknown', () => {
    expect(composeHref('https://x.test/c', 5, undefined)).toBe('https://x.test/c?pitchbox_draft=5');
  });
});

// issue #325: `composeUrl` used to be an agent-supplied input to
// `drafts_create`, built by hand-percent-encoding subject/body - an
// independent argument from `body` with nothing enforcing agreement between
// the two. `buildRedditComposeUrl` (and its Hacker News / Mastodon siblings)
// now build it server-side from the same fields already on the draft, so
// the compose URL and the reviewed body can never diverge.
describe('buildRedditComposeUrl (issue #325)', () => {
  it('the dm message= param decodes to exactly drafts.body for characters hand percent-encoding gets wrong', () => {
    // Spaces, &, =, #, +, a non-ASCII character and an apostrophe: each is
    // either a query-string metacharacter or one `encodeURIComponent` and a
    // hand-rolled encoder disagree on (+ in particular round-trips through
    // `+` as a literal space unless it is itself escaped).
    const body = "budget's tight: 50% off + free shipping (US & EU only) #deal café";
    const url = buildRedditComposeUrl({
      kind: 'dm',
      targetUser: 'alice',
      subreddit: null,
      title: null,
      body,
      subject: 'quick question about your setup',
      sourceRef: {},
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe('https://www.reddit.com/message/compose');
    expect(parsed.searchParams.get('message')).toBe(body);
    expect(parsed.searchParams.get('to')).toBe('alice');
    expect(parsed.searchParams.get('subject')).toBe('quick question about your setup');
  });

  it('omits the subject param when the campaign has none', () => {
    const url = buildRedditComposeUrl({
      kind: 'dm',
      targetUser: 'alice',
      subreddit: null,
      title: null,
      body: 'hi',
      subject: null,
      sourceRef: {},
    });
    expect(new URL(url!).searchParams.has('subject')).toBe(false);
  });

  it('builds a post compose URL from subreddit + title + body, not a caller-supplied URL', () => {
    const url = buildRedditComposeUrl({
      kind: 'post',
      targetUser: null,
      subreddit: 'rpg',
      title: 'Title with & and = in it',
      body: 'body & more',
      subject: null,
      sourceRef: {},
    });
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe('https://www.reddit.com/r/rpg/submit');
    expect(parsed.searchParams.get('title')).toBe('Title with & and = in it');
    expect(parsed.searchParams.get('text')).toBe('body & more');
  });

  it('a post_comment compose URL is just the thread permalink, with no body prefill', () => {
    const url = buildRedditComposeUrl({
      kind: 'post_comment',
      targetUser: null,
      subreddit: 'rpg',
      title: null,
      body: 'a comment',
      subject: null,
      sourceRef: { permalink: '/r/rpg/comments/abc/x/' },
    });
    expect(url).toBe('https://www.reddit.com/r/rpg/comments/abc/x/');
  });

  it('returns null rather than guessing when the required target is missing', () => {
    expect(
      buildRedditComposeUrl({
        kind: 'dm',
        targetUser: null,
        subreddit: null,
        title: null,
        body: 'hi',
        subject: null,
        sourceRef: {},
      }),
    ).toBeNull();
    expect(
      buildRedditComposeUrl({
        kind: 'post',
        targetUser: null,
        subreddit: null,
        title: null,
        body: 'hi',
        subject: null,
        sourceRef: {},
      }),
    ).toBeNull();
  });
});
