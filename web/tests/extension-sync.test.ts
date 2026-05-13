import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hasChatUnauthorizedDevice } from '../src/lib/server/extension-sync.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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
          captured_at: '2026-05-12T10:00:00Z',
          updated_at: '2026-05-12T10:00:00Z',
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
            captured_at: '2026-05-12T10:00:00Z',
            updated_at: '2026-05-12T10:00:00Z',
          },
        },
        {
          label: 'broken',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSyncStatus: {
            chat: 'unauthorized',
            legacy: 'ok',
            captured_at: '2026-05-12T10:00:00Z',
            updated_at: '2026-05-12T10:00:00Z',
          },
        },
      ]);
    expect(await hasChatUnauthorizedDevice()).toBe(true);
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
          captured_at: '2026-05-12T10:00:00Z',
          updated_at: '2026-05-12T10:00:00Z',
        },
      });
    expect(await hasChatUnauthorizedDevice()).toBe(false);
  });
});

afterAll(async () => {
  await getPool().end();
});
