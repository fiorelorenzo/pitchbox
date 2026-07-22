import { describe, it, expect } from 'vitest';
import { originStillNeeded } from '../../src/lib/permissions.js';

const A = { backendUrl: 'https://a.example', token: 'ta' };
const A_OTHER_TOKEN = { backendUrl: 'https://a.example', token: 'ta2' };
const B = { backendUrl: 'https://b.example', token: 'tb' };

describe('originStillNeeded', () => {
  it('is false when no remaining pairing shares the origin', () => {
    expect(originStillNeeded([], 'https://a.example')).toBe(false);
    expect(originStillNeeded([B], 'https://a.example')).toBe(false);
  });

  it('is true when another remaining pairing shares the origin', () => {
    expect(originStillNeeded([A, B], 'https://a.example')).toBe(true);
    // Same origin, different pairing entry (e.g. re-paired with a new token).
    expect(originStillNeeded([A_OTHER_TOKEN], 'https://a.example')).toBe(true);
  });

  it('ignores unparseable backend URLs instead of throwing', () => {
    expect(originStillNeeded([{ backendUrl: 'not-a-url', token: 't' }], 'https://a.example')).toBe(
      false,
    );
  });
});
