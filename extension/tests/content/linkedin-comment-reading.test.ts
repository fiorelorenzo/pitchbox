// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findPostComments,
  findParentCommentId,
  readCommentAuthor,
  readCommentBody,
  readCommentRelativeTime,
  findMessageEvents,
  resetSelectorHealth,
} from '../../src/content/shared/linkedin-dom.js';
import POST_DETAIL_HTML from './fixtures/linkedin/post-detail.html?raw';

// post-detail.html is the same anonymised, real, signed-in capture
// linkedin-dom.test.ts already exercises (see that fixture's README): 8
// top-level comments, each with exactly one nested reply article. #307 adds
// the comment/reply reading these tests cover; no new fixture is captured -
// this reuses the existing one.

function render(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetSelectorHealth();
});

describe('post-detail.html: comment/reply reading (#307, real capture)', () => {
  it('findPostComments finds all 16 comment articles (8 top-level + 8 nested replies)', () => {
    render(POST_DETAIL_HTML);
    expect(findPostComments(document)).toHaveLength(16);
  });

  it('a top-level comment has no parent comment id (its parent is the post itself)', () => {
    render(POST_DETAIL_HTML);
    const [topLevel] = findPostComments(document);
    expect(findParentCommentId(topLevel, document)).toBeNull();
  });

  it('a nested reply resolves its parent to the enclosing comment id', () => {
    render(POST_DETAIL_HTML);
    const [topLevel, reply] = findPostComments(document);
    const parentId = findParentCommentId(reply, document);
    expect(parentId).toBe(topLevel.getAttribute('data-id'));
    expect(parentId).toMatch(/^urn:li:comment:/);
  });

  it("readCommentAuthor reads the top-level comment's byline name and handle, not its reply's", () => {
    render(POST_DETAIL_HTML);
    const [topLevel] = findPostComments(document);
    const author = readCommentAuthor(topLevel, document);
    expect(author.name).toBe('Marco Rossi');
    expect(author.handle).toBe('example-person');
  });

  it("readCommentAuthor reads the nested reply's own byline, not the parent's", () => {
    render(POST_DETAIL_HTML);
    const [, reply] = findPostComments(document);
    const author = readCommentAuthor(reply, document);
    expect(author.name).toBe('Giulia Bianchi');
  });

  it('readCommentBody reads the top-level comment text', () => {
    render(POST_DETAIL_HTML);
    const [topLevel] = findPostComments(document);
    const body = readCommentBody(topLevel, document);
    expect(body).toBeTruthy();
    expect(body).toMatch(/ingest path/);
    // The "…altro" (see more) toggle sits in the same <section> as the text
    // - it must never leak into the body.
    expect(body).not.toMatch(/altro/);
  });

  it("readCommentBody strips the reply's leading self-mention and keeps its real text", () => {
    render(POST_DETAIL_HTML);
    const [, reply] = findPostComments(document);
    const body = readCommentBody(reply, document);
    expect(body).toBeTruthy();
    expect(body).toMatch(/ingest path/);
    expect(body?.startsWith('Giulia Bianchi')).toBe(false);
  });

  it('readCommentRelativeTime reads the relative-time text as-is, never a machine date', () => {
    render(POST_DETAIL_HTML);
    const [topLevel] = findPostComments(document);
    const relativeTime = readCommentRelativeTime(topLevel, document);
    expect(relativeTime).toBeTruthy();
    // The real capture is from an Italian-locale account; this is exactly
    // the reason a caller must never treat this string as parseable in
    // general (see LinkedInComment.relativeTime's doc comment).
    expect(Number.isNaN(Date.parse(relativeTime!))).toBe(true);
  });
});

describe('synthetic markup: findMessageEvents (#307, unverified against a live capture)', () => {
  it('reads a message row from a <time> plus a nearby profile link', () => {
    render(`
      <ul>
        <li>
          <a href="/in/jane-doe/">Jane Doe</a>
          <time>2h</time>
          <div>Jane DoeThanks for reaching out, let's talk next week</div>
        </li>
      </ul>
    `);
    const events = findMessageEvents(document);
    expect(events).toHaveLength(1);
    expect(events[0].participant.handle).toBe('jane-doe');
    expect(events[0].relativeTime).toBe('2h');
    expect(events[0].body).toBe("Thanks for reaching out, let's talk next week");
  });

  it('reads multiple message rows independently', () => {
    render(`
      <ul>
        <li><a href="/in/alice/">Alice</a><time>1d</time><div>AliceHello</div></li>
        <li><a href="/in/bob/">Bob</a><time>2d</time><div>BobHi there</div></li>
      </ul>
    `);
    const events = findMessageEvents(document);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.participant.handle)).toEqual(['alice', 'bob']);
  });

  it('returns [] when the page has no <time> elements at all', () => {
    render('<div>nothing here</div>');
    expect(findMessageEvents(document)).toEqual([]);
  });
});
