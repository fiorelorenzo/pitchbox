import { describe, it, expect } from 'vitest';
import { parseDraftId } from '../../src/lib/draft-param.js';

describe('parseDraftId', () => {
  it('reads from current URL', () => {
    expect(parseDraftId('https://www.reddit.com/message/compose?to=alice&pitchbox_draft=42')).toBe(
      42,
    );
  });
  it('returns null when missing', () => {
    expect(parseDraftId('https://www.reddit.com/message/compose?to=alice')).toBeNull();
  });
  it('returns null for non-integer', () => {
    expect(parseDraftId('https://x.test/?pitchbox_draft=abc')).toBeNull();
  });
  it('returns null for negative', () => {
    expect(parseDraftId('https://x.test/?pitchbox_draft=-1')).toBeNull();
  });
  it('returns null for zero', () => {
    expect(parseDraftId('https://x.test/?pitchbox_draft=0')).toBeNull();
  });
});
