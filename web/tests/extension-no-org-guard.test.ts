import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * Issue #196: when no organization can be resolved (e.g. a broken/incomplete
 * install with no 'default' org row and no session context), auto-pair and
 * the admin pairing-code generator must fail loudly (409) instead of minting
 * an orphaned (null-org) device/pairing.
 *
 * This exercises the guard without touching the real seeded 'default' org
 * other test files rely on: the DB layer is stubbed so every SELECT resolves
 * empty, mirroring the one condition (`resolveOrgId`'s fallback query finding
 * nothing) under which these routes would otherwise produce a null org.
 */

// vi.mock is hoisted above these declarations, so anything its factory
// closes over must itself be created via vi.hoisted().
const { insertSpy, emptyDb } = vi.hoisted(() => {
  const insertSpy = vi.fn();
  function emptyDb() {
    const chain: Record<string, (...args: unknown[]) => unknown> = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([]),
      insert: (...args: unknown[]) => {
        insertSpy(...args);
        return chain;
      },
      values: () => chain,
      returning: () => Promise.resolve([]),
    };
    return chain;
  }
  return { insertSpy, emptyDb };
});

vi.mock('$lib/server/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/server/db.js')>();
  return { ...actual, getDb: () => emptyDb() };
});

function bareEvent(request: Request): RequestEvent {
  return { locals: {}, request } as unknown as RequestEvent;
}

beforeEach(() => {
  insertSpy.mockClear();
});

describe('POST /api/settings/extension-pairing with no organization resolvable', () => {
  it('fails loudly (409) instead of minting an orphaned pairing code', async () => {
    const { POST: extensionPairingPost } =
      await import('../src/routes/api/settings/extension-pairing/+server.js');
    const request = new Request('http://x/api/settings/extension-pairing', { method: 'POST' });
    await expect(extensionPairingPost(bareEvent(request))).rejects.toMatchObject({ status: 409 });
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/extension/auto-pair with no organization resolvable', () => {
  const originalAuth = process.env.PITCHBOX_AUTH;

  it('fails loudly (409) instead of minting an orphaned device', async () => {
    // AUTH off (the default): the route resolves the org via its own
    // defaultOrgId() DB lookup, which the mock above starves of any row.
    delete process.env.PITCHBOX_AUTH;
    const { POST: autoPairPost } = await import('../src/routes/api/extension/auto-pair/+server.js');
    await expect(
      autoPairPost({
        cookies: { get: () => undefined },
        request: new Request('http://x/api/extension/auto-pair', { method: 'POST' }),
      } as unknown as Parameters<typeof autoPairPost>[0]),
    ).rejects.toMatchObject({ status: 409 });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  afterAll(() => {
    // process.env is process-wide, not file-scoped, so restore it for later
    // test files sharing this worker (mirrors extension-device-org.test.ts).
    if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
    else process.env.PITCHBOX_AUTH = originalAuth;
  });
});
