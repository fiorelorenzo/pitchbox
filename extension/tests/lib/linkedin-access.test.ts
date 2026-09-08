import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLinkedInAccessState, recordLinkedInAccess } from '../../src/lib/linkedin-access.js';

const store: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch);
      },
    },
  },
});

// The module touches `chrome` only inside its functions, so a static import
// is safe here even though the stub above is installed at module scope.
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

// #401: home paints red on a permission Chrome took away. The trap is that
// "absent" and "taken away" are the same observation from chrome.permissions,
// and one of them is every fresh install.
describe('recordLinkedInAccess', () => {
  it('a fresh install that never had the permission is not a revocation', async () => {
    await recordLinkedInAccess(false);
    expect(await getLinkedInAccessState()).toEqual({});
  });

  it('records the transition once the permission has been seen and then goes', async () => {
    await recordLinkedInAccess(true, '2026-09-08T10:00:00.000Z');
    expect(await getLinkedInAccessState()).toEqual({ grantedAt: '2026-09-08T10:00:00.000Z' });

    await recordLinkedInAccess(false, '2026-09-08T11:00:00.000Z');
    expect(await getLinkedInAccessState()).toEqual({ revokedAt: '2026-09-08T11:00:00.000Z' });
  });

  it('keeps the moment it went away rather than the moment we last looked', async () => {
    await recordLinkedInAccess(true, '2026-09-08T10:00:00.000Z');
    await recordLinkedInAccess(false, '2026-09-08T11:00:00.000Z');
    // The worker re-runs this on every boot and every permission event.
    await recordLinkedInAccess(false, '2026-09-08T12:30:00.000Z');
    await recordLinkedInAccess(false, '2026-09-08T13:00:00.000Z');
    expect(await getLinkedInAccessState()).toEqual({ revokedAt: '2026-09-08T11:00:00.000Z' });
  });

  it('clears the revocation when the permission comes back', async () => {
    await recordLinkedInAccess(true, '2026-09-08T10:00:00.000Z');
    await recordLinkedInAccess(false, '2026-09-08T11:00:00.000Z');
    await recordLinkedInAccess(true, '2026-09-08T12:00:00.000Z');
    expect(await getLinkedInAccessState()).toEqual({ grantedAt: '2026-09-08T12:00:00.000Z' });
  });

  it('survives a garbage value in storage without throwing', async () => {
    store.linkedInAccess = 'not an object';
    expect(await getLinkedInAccessState()).toEqual({});
  });
});
