import { describe, expect, it } from 'vitest';
import { encodeThreadId, decodeThreadId } from '../src/routes/conversations/[id]/thread-id.js';

describe('thread-id encode/decode', () => {
  it('round-trips realistic Reddit handles', () => {
    const key = {
      accountHandle: 'pitchbox_bot',
      targetUser: 'some_reddit_user-99',
      platform: 'reddit',
    };
    const id = encodeThreadId(key);
    expect(id).not.toContain('|');
    expect(id).not.toContain('/');
    expect(id).not.toContain('+');
    expect(decodeThreadId(id)).toEqual(key);
  });

  it('round-trips short handles', () => {
    const key = { accountHandle: 'a', targetUser: 'b', platform: 'reddit' };
    expect(decodeThreadId(encodeThreadId(key))).toEqual(key);
  });

  it('rejects malformed thread ids', () => {
    // base64 of "only|two" - only two segments after decode
    const bad = Buffer.from('only|two', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    expect(() => decodeThreadId(bad)).toThrow();
  });

  it('rejects pipe characters at encode time', () => {
    expect(() =>
      encodeThreadId({
        accountHandle: 'a|b',
        targetUser: 'u',
        platform: 'reddit',
      }),
    ).toThrow();
  });

  it('rejects empty components at encode time', () => {
    expect(() =>
      encodeThreadId({ accountHandle: '', targetUser: 'u', platform: 'reddit' }),
    ).toThrow();
  });
});
