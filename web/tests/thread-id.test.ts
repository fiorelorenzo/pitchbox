import { describe, expect, it } from 'vitest';
import { decodeThreadId, encodeThreadId } from '../src/routes/conversations/[id]/thread-id.js';

// #227: encodeThreadId/decodeThreadId used to be implemented with a Node-only
// global, undefined in the browser, which made hydration die silently. These
// tests pin the browser-safe TextEncoder/TextDecoder + btoa/atob replacement to
// the same contract: stable round-trip, URL-safe output, UTF-8 correctness, and
// loud throws on malformed input. Absence of the Node-only global itself is
// enforced by a source grep (see the wave's acceptance criteria), not a runtime check.

// Builds a raw base64url payload the same way toBase64Url does internally, so
// tests can construct malformed-shape inputs without importing a private helper.
function rawBase64Url(payload: string): string {
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('thread-id', () => {
  it('round-trips an ASCII triple', () => {
    const key = { accountHandle: 'my_bot', targetUser: 'some_user', platform: 'reddit' };
    const id = encodeThreadId(key);
    expect(decodeThreadId(id)).toEqual(key);
  });

  it('round-trips a triple containing non-ASCII handles', () => {
    const key = { accountHandle: 'büro_bot', targetUser: '田中さん', platform: 'reddit' };
    const id = encodeThreadId(key);
    expect(decodeThreadId(id)).toEqual(key);
  });

  it('produces URL-safe output with no padding', () => {
    const id = encodeThreadId({
      accountHandle: 'a-handle-that-is-long-enough-to-need-padding',
      targetUser: 'another-long-target-user-handle',
      platform: 'reddit',
    });
    expect(id).not.toMatch(/[+/=]/);
    expect(id).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('throws on malformed base64url input', () => {
    expect(() => decodeThreadId('not valid base64url!!!')).toThrow(
      'decodeThreadId: not a valid base64url string',
    );
  });

  it('throws when the decoded payload does not have exactly three parts', () => {
    expect(() => decodeThreadId(rawBase64Url('only-one-part'))).toThrow(
      'decodeThreadId: malformed thread id',
    );
    expect(() => decodeThreadId(rawBase64Url('a|b|c|d'))).toThrow(
      'decodeThreadId: malformed thread id',
    );
  });

  it('throws when a component is empty', () => {
    expect(() => decodeThreadId(rawBase64Url('a||c'))).toThrow(
      'decodeThreadId: malformed thread id',
    );
  });

  it('rejects a pipe character in any field at encode time', () => {
    expect(() =>
      encodeThreadId({ accountHandle: 'a|b', targetUser: 'user', platform: 'reddit' }),
    ).toThrow('encodeThreadId: pipe character is not allowed in thread key fields');
  });

  it('requires all three fields to encode', () => {
    expect(() =>
      encodeThreadId({ accountHandle: '', targetUser: 'user', platform: 'reddit' }),
    ).toThrow('encodeThreadId: all three fields are required');
  });
});
