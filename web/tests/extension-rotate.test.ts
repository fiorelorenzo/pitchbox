import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { requireExtensionAuth } from '../src/lib/server/extension-auth.js';
import { POST as rotate } from '../src/routes/api/extension/rotate/+server.js';

/**
 * Issue #185: POST /api/extension/rotate mints a fresh token + 90-day expiry
 * for the calling device's row and immediately invalidates the old hash.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function bearerRequest(token: string): Request {
  return new Request('http://localhost/api/extension/rotate', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function reset() {
  await getDb().execute(sql`TRUNCATE extension_devices RESTART IDENTITY CASCADE`);
}

async function statusOf(promise: Promise<Response>): Promise<number> {
  try {
    return (await promise).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe('POST /api/extension/rotate', () => {
  beforeEach(reset);

  it('mints a new token that works and kills the old one', async () => {
    const oldToken = randomBytes(32).toString('hex');
    const [row] = await getDb()
      .insert(schema.extensionDevices)
      .values({ label: 'rotate-me', tokenHash: hashToken(oldToken) })
      .returning();

    const res = await rotate({ request: bearerRequest(oldToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe(oldToken);

    // Old token is dead immediately.
    await expect(requireExtensionAuth(bearerRequest(oldToken))).rejects.toMatchObject({
      status: 401,
    });

    // New token authenticates as the same device.
    await expect(requireExtensionAuth(bearerRequest(body.token))).resolves.toEqual({
      deviceId: row.id,
      organizationId: null,
    });

    const [fresh] = await getDb()
      .select({ expiresAt: schema.extensionDevices.expiresAt })
      .from(schema.extensionDevices)
      .where(eq(schema.extensionDevices.id, row.id));
    expect(fresh.expiresAt).not.toBeNull();
    const daysUntilExpiry = (fresh.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(89);
    expect(daysUntilExpiry).toBeLessThanOrEqual(90);
    expect(new Date(body.expiresAt).getTime()).toBe(fresh.expiresAt!.getTime());
  });

  it('serializes two concurrent rotations of the same token (one 200, one 409)', async () => {
    const oldToken = randomBytes(32).toString('hex');
    const [row] = await getDb()
      .insert(schema.extensionDevices)
      .values({ label: 'race', tokenHash: hashToken(oldToken) })
      .returning();

    const [a, b] = await Promise.all([
      statusOf(rotate({ request: bearerRequest(oldToken) })),
      statusOf(rotate({ request: bearerRequest(oldToken) })),
    ]);
    // The compare-and-swap lets exactly ONE win (200). The loser either 409s
    // (its CAS matched nothing because the hash already moved) or 401s (the
    // winner's rotate invalidated the shared old token before the loser even
    // authenticated) - either way it does NOT clobber the winner's token, so a
    // concurrent double-rotate can't lose an update and brick the pairing.
    expect([a, b].filter((s) => s === 200)).toHaveLength(1);
    expect([a, b].filter((s) => s === 401 || s === 409)).toHaveLength(1);

    // The row holds one new hash, and the old token no longer authenticates.
    const [fresh] = await getDb()
      .select({ tokenHash: schema.extensionDevices.tokenHash })
      .from(schema.extensionDevices)
      .where(eq(schema.extensionDevices.id, row.id));
    expect(fresh.tokenHash).not.toBe(hashToken(oldToken));
    await expect(requireExtensionAuth(bearerRequest(oldToken))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects rotation for an unauthenticated request', async () => {
    await expect(
      rotate({ request: new Request('http://localhost/api/extension/rotate', { method: 'POST' }) }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects rotation for an already-revoked device', async () => {
    const token = randomBytes(32).toString('hex');
    await getDb()
      .insert(schema.extensionDevices)
      .values({ label: 'revoked', tokenHash: hashToken(token), revokedAt: new Date() });

    await expect(rotate({ request: bearerRequest(token) })).rejects.toMatchObject({ status: 401 });
  });
});

afterAll(async () => {
  await getPool().end();
});
