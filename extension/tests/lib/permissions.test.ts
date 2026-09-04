import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  originStillNeeded,
  LINKEDIN_ORIGIN,
  hasLinkedInPermission,
  requestLinkedInPermission,
  revokeLinkedInPermission,
} from '../../src/lib/permissions.js';

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

describe('LinkedIn host permission (#317)', () => {
  const contains = vi.fn();
  const request = vi.fn();
  const remove = vi.fn();

  beforeEach(() => {
    contains.mockReset();
    request.mockReset();
    remove.mockReset();
    vi.stubGlobal('chrome', { permissions: { contains, request, remove } });
  });

  it('requests exactly the LinkedIn origin', async () => {
    request.mockResolvedValue(true);
    const granted = await requestLinkedInPermission();
    expect(granted).toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: [LINKEDIN_ORIGIN] });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('resolves false on an explicit decline rather than throwing', async () => {
    request.mockResolvedValue(false);
    expect(await requestLinkedInPermission()).toBe(false);
  });

  it('reflects chrome.permissions.contains, granted or not', async () => {
    contains.mockResolvedValue(true);
    expect(await hasLinkedInPermission()).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: [LINKEDIN_ORIGIN] });

    contains.mockResolvedValue(false);
    expect(await hasLinkedInPermission()).toBe(false);
  });

  it('revokes exactly the LinkedIn origin', async () => {
    remove.mockResolvedValue(true);
    const removed = await revokeLinkedInPermission();
    expect(removed).toBe(true);
    expect(remove).toHaveBeenCalledWith({ origins: [LINKEDIN_ORIGIN] });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
