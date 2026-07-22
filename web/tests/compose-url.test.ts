import { describe, expect, it } from 'vitest';
import { composeHref } from '../src/lib/utils/compose-url.js';

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
