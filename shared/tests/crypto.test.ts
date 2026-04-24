import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from '../src/crypto.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('crypto', () => {
  it('round-trips plaintext', () => {
    const plaintext = 'hello world';
    const ct = encrypt(plaintext, KEY);
    expect(ct).not.toBe(plaintext);
    const pt = decrypt(ct, KEY);
    expect(pt).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encrypt('x', KEY);
    const b = encrypt('x', KEY);
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', () => {
    const ct = encrypt('abc', KEY);
    const tampered = ct.slice(0, -4) + 'zzzz';
    expect(() => decrypt(tampered, KEY)).toThrow();
  });
});
