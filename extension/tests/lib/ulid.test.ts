import { describe, it, expect } from 'vitest';
import { ulid } from '../../src/lib/ulid.js';

describe('ulid', () => {
  it('returns a 26 char Crockford-base32 string', () => {
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it('produces sortable ids across time', async () => {
    const a = ulid();
    await new Promise((r) => setTimeout(r, 2));
    const b = ulid();
    expect(b > a).toBe(true);
  });
  it('produces unique values', () => {
    const set = new Set(Array.from({ length: 500 }, () => ulid()));
    expect(set.size).toBe(500);
  });
});
