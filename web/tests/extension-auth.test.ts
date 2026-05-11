import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { rotateExtensionToken } from '@pitchbox/shared/extension-token';
import { requireExtensionAuth } from '../src/lib/server/extension-auth.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE extension_devices, extension_pairings RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM app_config WHERE key LIKE 'extension_%'`);
}

function authedRequest(token: string | null): Request {
  const headers = new Headers();
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return new Request('http://localhost/api/extension/handshake', { method: 'POST', headers });
}

describe('extension auth', () => {
  beforeEach(reset);

  it('rejects requests without a bearer header', async () => {
    await expect(requireExtensionAuth(authedRequest(null))).rejects.toMatchObject({
      status: 401,
      body: { message: 'missing bearer token' },
    });
  });

  it('rejects unknown tokens', async () => {
    await expect(requireExtensionAuth(authedRequest('deadbeef'))).rejects.toMatchObject({
      status: 401,
      body: { message: 'invalid token' },
    });
  });

  it('accepts a registered per-device token and updates lastSeenAt', async () => {
    const token = randomBytes(32).toString('hex');
    const [row] = await getDb()
      .insert(schema.extensionDevices)
      .values({ label: 'test device', tokenHash: hashToken(token) })
      .returning();

    await expect(requireExtensionAuth(authedRequest(token))).resolves.toBeUndefined();

    const [fresh] = await getDb()
      .select({ lastSeenAt: schema.extensionDevices.lastSeenAt })
      .from(schema.extensionDevices)
      .where(sql`id = ${row.id}`);
    expect(fresh.lastSeenAt).not.toBeNull();
  });

  it('rejects revoked devices', async () => {
    const token = randomBytes(32).toString('hex');
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        label: 'revoked',
        tokenHash: hashToken(token),
        revokedAt: new Date(),
      });

    await expect(requireExtensionAuth(authedRequest(token))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('falls back to the legacy shared app_config token', async () => {
    const token = await rotateExtensionToken();
    await expect(requireExtensionAuth(authedRequest(token))).resolves.toBeUndefined();
  });
});

afterAll(async () => {
  await getPool().end();
});
