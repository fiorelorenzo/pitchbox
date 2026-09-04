// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findComposeTextarea,
  findComposeSendButton,
  findCommentTextarea,
  findCommentSubmitButton,
  findOurCommentId,
} from '../../src/content/shared/reddit-dom.js';
import REDDIT_THREAD_HTML from './fixtures/reddit/comment-thread.html?raw';

// The synthetic cases below predate the real capture and are kept on purpose: they
// cover shapes the captured page does not contain (a closed shadow root, two
// levels of nesting, old.reddit.com's plain form). The real markup is exercised
// against `fixtures/reddit/comment-thread.html` further down - that capture is
// what settled how a comment is actually rendered.

beforeEach(() => {
  document.body.innerHTML = '';
});

function attachShadow(host: Element, mode: 'open' | 'closed', innerHTML: string): ShadowRoot {
  const shadow = host.attachShadow({ mode });
  shadow.innerHTML = innerHTML;
  return shadow;
}

describe('old.reddit.com style markup (plain form, no shadow DOM)', () => {
  it('findComposeTextarea finds a plain textarea[name="text"]', () => {
    document.body.innerHTML = `
      <form>
        <textarea name="text"></textarea>
        <button type="submit">send</button>
      </form>
    `;
    expect(findComposeTextarea()).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('findComposeTextarea falls back to a placeholder-matched textarea', () => {
    document.body.innerHTML = `<textarea placeholder="Type your message"></textarea>`;
    expect(findComposeTextarea()).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('findComposeSendButton finds a button[type="submit"]', () => {
    document.body.innerHTML = `
      <form>
        <textarea name="text"></textarea>
        <button type="submit">send</button>
      </form>
    `;
    const btn = findComposeSendButton();
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect(btn?.textContent?.trim()).toBe('send');
  });

  it('findComposeSendButton falls back to text-matching when there is no submit button', () => {
    document.body.innerHTML = `<button>Send</button>`;
    const btn = findComposeSendButton();
    expect(btn?.textContent).toBe('Send');
  });

  it('findCommentTextarea finds a plain textarea[name="text"]', () => {
    document.body.innerHTML = `<textarea name="text"></textarea>`;
    expect(findCommentTextarea()).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('findCommentTextarea falls back to a contenteditable textbox', () => {
    document.body.innerHTML = `<div contenteditable="true" role="textbox"></div>`;
    const el = findCommentTextarea();
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('textbox');
  });

  it('findCommentSubmitButton matches a button by text', () => {
    document.body.innerHTML = `<button>Comment</button>`;
    expect(findCommentSubmitButton()?.textContent).toBe('Comment');
  });
});

describe('www.reddit.com style markup (shadow-DOM encapsulated controls)', () => {
  it('findComposeTextarea pierces an open shadow root when the plain query misses', () => {
    const host = document.createElement('shreddit-compose-form');
    document.body.appendChild(host);
    attachShadow(host, 'open', '<textarea name="text"></textarea>');

    // Sanity check: the plain top-level query really does miss - proving the
    // fallback, not the fast path, is what finds it below.
    expect(document.querySelector('textarea[name="text"]')).toBeNull();

    expect(findComposeTextarea()).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('findComposeSendButton pierces an open shadow root for a submit button', () => {
    const host = document.createElement('shreddit-compose-form');
    document.body.appendChild(host);
    attachShadow(host, 'open', '<button type="submit">Send</button>');

    expect(document.querySelector('button[type="submit"]')).toBeNull();
    expect(findComposeSendButton()).toBeInstanceOf(HTMLButtonElement);
  });

  it('findComposeSendButton pierces an open shadow root for a text-matched send button', () => {
    const host = document.createElement('shreddit-compose-form');
    document.body.appendChild(host);
    attachShadow(host, 'open', '<button>Send</button>');

    expect(findComposeSendButton()?.textContent).toBe('Send');
  });

  it('findCommentTextarea pierces a shadow root nested two levels deep', () => {
    const outerHost = document.createElement('shreddit-comment-tree');
    document.body.appendChild(outerHost);
    const outerShadow = attachShadow(outerHost, 'open', '');
    const innerHost = document.createElement('shreddit-composer');
    outerShadow.appendChild(innerHost);
    attachShadow(innerHost, 'open', '<div contenteditable="true" role="textbox"></div>');

    const found = findCommentTextarea();
    expect(found).not.toBeNull();
    expect(found?.getAttribute('role')).toBe('textbox');
  });

  it('findCommentSubmitButton pierces an open shadow root, scoped to a given root', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = document.createElement('shreddit-composer');
    container.appendChild(host);
    attachShadow(host, 'open', '<button>Reply</button>');

    expect(findCommentSubmitButton(container)?.textContent).toBe('Reply');
  });

  it('does not (and cannot) reach into a closed shadow root', () => {
    const host = document.createElement('shreddit-compose-form');
    document.body.appendChild(host);
    attachShadow(host, 'closed', '<textarea name="text"></textarea>');

    // Closed roots are unreachable from outside by design (host.shadowRoot is
    // null), so the fallback correctly finds nothing rather than piercing it.
    expect(host.shadowRoot).toBeNull();
    expect(findComposeTextarea()).toBeNull();
  });
});

// comment-thread.html is an anonymised capture of a real, signed-in
// www.reddit.com thread (2026-09-04) - see fixtures/reddit/README.md for what was
// stripped and how to regenerate it. Loaded with Vite's `?raw` import (not
// `node:fs`) because the extension's tsconfig has no Node type defs.
describe('comment-thread.html (real www.reddit.com capture)', () => {
  // Attributes on the captured comments, in page order. The last one is ours.
  const OURS = 't1_fixture25';
  const OURS_CREATED_MS = Date.parse('2026-09-04T13:22:46.500Z');
  const NEWEST_OTHER_CREATED_MS = Date.parse('2026-09-04T00:40:33.978Z');

  /**
   * The capture records each open shadow root as a `<template
   * data-fixture-shadow-root="open">` rather than flattening it, since a content
   * script has to pierce those for real. Re-attach them so `queryDeep` is
   * exercised against the page's actual encapsulation.
   */
  function hydrateShadowRoots(root: ParentNode): number {
    let attached = 0;
    for (const tpl of Array.from(root.querySelectorAll('template[data-fixture-shadow-root]'))) {
      const host = tpl.parentElement;
      if (!host || host.shadowRoot) continue;
      const shadow = host.attachShadow({ mode: 'open' });
      tpl.remove();
      while (tpl.firstChild) shadow.appendChild(tpl.firstChild);
      attached++;
      attached += hydrateShadowRoots(shadow);
    }
    return attached;
  }

  function renderCapture(): void {
    document.body.innerHTML = REDDIT_THREAD_HTML;
    hydrateShadowRoots(document.body);
  }

  it('finds our own comment id among seven other authors', () => {
    renderCapture();
    expect(findOurCommentId('fixture_owner')).toBe(OURS);
  });

  it('matches the handle case-insensitively, the way Reddit treats it', () => {
    renderCapture();
    expect(findOurCommentId('Fixture_Owner')).toBe(OURS);
  });

  it('returns null for a handle that has not commented, rather than the newest comment', () => {
    renderCapture();
    expect(findOurCommentId('nobody_here')).toBeNull();
  });

  it('accepts our comment when it is newer than the arming moment', () => {
    renderCapture();
    expect(findOurCommentId('fixture_owner', { notBeforeMs: OURS_CREATED_MS - 60_000 })).toBe(OURS);
  });

  it('rejects a comment of ours predating the arming moment, so an old one is never claimed', () => {
    renderCapture();
    // The send we are attributing happened after every comment on the page: the
    // account's own older comment must not be recorded as the one just posted,
    // or every reply to it would be attributed to this draft.
    expect(findOurCommentId('fixture_owner', { notBeforeMs: OURS_CREATED_MS + 1 })).toBeNull();
  });

  it('ignores a newer comment by somebody else', () => {
    renderCapture();
    // Another author's comment sits between ours and the arming window's floor.
    expect(NEWEST_OTHER_CREATED_MS).toBeLessThan(OURS_CREATED_MS);
    expect(findOurCommentId('fourth_author', { notBeforeMs: OURS_CREATED_MS })).toBeNull();
  });
});

describe('findOurCommentId on synthetic markup', () => {
  function comment(attrs: Record<string, string>): void {
    const el = document.createElement('shreddit-comment');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
  }

  it('picks the newest of several comments by us', () => {
    comment({ thingid: 't1_old', author: 'me', created: '2026-09-01T10:00:00.000Z' });
    comment({ thingid: 't1_new', author: 'me', created: '2026-09-03T10:00:00.000Z' });
    comment({ thingid: 't1_mid', author: 'me', created: '2026-09-02T10:00:00.000Z' });

    expect(findOurCommentId('me')).toBe('t1_new');
  });

  it('treats an unparseable created as no evidence of when, so a window rejects it', () => {
    comment({ thingid: 't1_undated', author: 'me', created: 'not a date' });

    // With no window the id is still better than nothing; with one, it cannot be
    // shown to be the comment we just posted.
    expect(findOurCommentId('me')).toBe('t1_undated');
    expect(findOurCommentId('me', { notBeforeMs: Date.now() - 60_000 })).toBeNull();
  });

  it('reaches a comment rendered inside an open shadow root', () => {
    const host = document.createElement('shreddit-comment-tree');
    document.body.appendChild(host);
    attachShadow(
      host,
      'open',
      '<shreddit-comment thingid="t1_deep" author="me" created="2026-09-03T10:00:00.000Z"></shreddit-comment>',
    );

    expect(findOurCommentId('me')).toBe('t1_deep');
  });
});
