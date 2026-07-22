import { describe, it, expect } from 'vitest';
import { parseBackendUrl, parseDraftId } from '../../src/lib/draft-param.js';

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

describe('parseBackendUrl', () => {
  it('reads the tagged backend origin from the compose URL', () => {
    const href =
      'https://www.reddit.com/message/compose?to=alice&pitchbox_draft=42' +
      '&pitchbox_backend=' +
      encodeURIComponent('https://pitchbox.app');
    expect(parseBackendUrl(href)).toBe('https://pitchbox.app');
  });
  it('normalizes to an origin (strips any path/trailing slash)', () => {
    const href = 'https://x.test/?pitchbox_backend=' + encodeURIComponent('http://localhost:5180/');
    expect(parseBackendUrl(href)).toBe('http://localhost:5180');
  });
  it('returns null when absent', () => {
    expect(parseBackendUrl('https://x.test/?pitchbox_draft=1')).toBeNull();
  });
  it('returns null for a non-http(s) value', () => {
    expect(
      parseBackendUrl('https://x.test/?pitchbox_backend=' + encodeURIComponent('ftp://evil')),
    ).toBeNull();
  });
});
