import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hasChatUnauthorizedDevice } from '../src/lib/server/extension-sync.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Timestamps must be RELATIVE to now: the code-under-test ignores sync
// statuses older than STALE_STATUS_MS (30 min). A hardcoded calendar date
// rots — once "today" drifts >30 min past it, every fixture reads as stale
// and the "unauthorized" assertions silently flip. "recent" sits well inside
// the window; "stale" sits well outside it.
const recentTimestamp = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
const staleTimestamp = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

async function reset() {
  await getDb().execute(sql`TRUNCATE extension_devices RESTART IDENTITY CASCADE`);
}

describe('hasChatUnauthorizedDevice', () => {
  beforeEach(reset);

  it('returns false when no devices are registered', async () => {
    expect(await hasChatUnauthorizedDevice()).toBe(false);
  });

  it('returns false when every device reports chat=ok', async () => {
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        label: 'd1',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        lastSyncStatus: {
          chat: 'ok',
          legacy: 'ok',
          captured_at: recentTimestamp(),
          updated_at: recentTimestamp(),
        },
      });
    expect(await hasChatUnauthorizedDevice()).toBe(false);
  });

  it('returns true as soon as one non-revoked device reports chat=unauthorized', async () => {
    await getDb()
      .insert(schema.extensionDevices)
      .values([
        {
          label: 'healthy',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSyncStatus: {
            chat: 'ok',
            legacy: 'ok',
            captured_at: recentTimestamp(),
            updated_at: recentTimestamp(),
          },
        },
        {
          label: 'broken',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSyncStatus: {
            chat: 'unauthorized',
            legacy: 'ok',
            captured_at: recentTimestamp(),
            updated_at: recentTimestamp(),
          },
        },
      ]);
    expect(await hasChatUnauthorizedDevice()).toBe(true);
  });

  it('ignores a stale unauthorized report past the freshness window', async () => {
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        label: 'stale',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        lastSyncStatus: {
          chat: 'unauthorized',
          legacy: 'ok',
          captured_at: staleTimestamp(),
          updated_at: staleTimestamp(),
        },
      });
    expect(await hasChatUnauthorizedDevice()).toBe(false);
  });

  it('ignores revoked devices', async () => {
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        label: 'revoked',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        revokedAt: new Date(),
        lastSyncStatus: {
          chat: 'unauthorized',
          legacy: 'ok',
          captured_at: recentTimestamp(),
          updated_at: recentTimestamp(),
        },
      });
    expect(await hasChatUnauthorizedDevice()).toBe(false);
  });
});

afterAll(async () => {
  await getPool().end();
});
