// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findComposeTextarea,
  findComposeSendButton,
  findCommentTextarea,
  findCommentSubmitButton,
} from '../../src/content/shared/reddit-dom.js';

// All markup below is synthetic - no real www.reddit.com/old.reddit.com DOM
// snapshot was captured for these fixtures (no browser is available in this
// environment). The shadow-DOM shape used for the "www.reddit" cases models
// Reddit's public `shreddit-*` custom-element pattern as a stand-in; capturing
// a real snapshot to replace it is a follow-up.

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
