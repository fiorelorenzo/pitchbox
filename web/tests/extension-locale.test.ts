import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { POST as localePost } from '../src/routes/api/extension/locale/+server.js';

/**
 * POST /api/extension/locale (LOR-262): the write half of the account-wide
 * language override, called from the extension's Settings tab picker
 * (LanguageCard.svelte) right after its own local `chrome.storage` write.
 * Modelled on extension-operator-profile.test.ts's own seeding/mintDevice
 * harness.
 */

async function reset() {
  await getDb().execute(sql`TRUNCATE users RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // A plain DELETE, not TRUNCATE ... RESTART IDENTITY: the plane's rate
  // limiter is keyed by numeric device id (see extension-observations.test.ts's
  // own note on this), so resetting the id sequence would collide two
  // tests' devices in the same in-memory bucket.
  await getDb().execute(sql`DELETE FROM extension_devices`);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function mintDevice(organizationId: number | null, token: string, userId?: number) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, userId: userId ?? null, tokenHash: tokenHash(token), label: 'test' });
}

async function seedOrg(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  return org;
}

function bearer(token: string | null, body: unknown): Request {
  return new Request('http://x/api/extension/locale', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

describe('POST /api/extension/locale', () => {
  beforeEach(reset);

  it('rejects a request with no bearer token (401)', async () => {
    await expect(localePost({ request: bearer(null, { locale: 'it' }) })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a locale outside the supported set (400)', async () => {
    const org = await seedOrg('loc-invalid');
    const token = 'device-token-invalid-locale';
    await mintDevice(org.id, token);
    await expect(localePost({ request: bearer(token, { locale: 'fr' }) })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('writes through to the bound user and reports synced: true', async () => {
    const org = await seedOrg('loc-bound');
    const [user] = await getDb()
      .insert(schema.users)
      .values({ username: 'loc-user', passwordHash: 'x' })
      .returning();
    const token = 'device-token-bound';
    await mintDevice(org.id, token, user.id);

    const res = await localePost({ request: bearer(token, { locale: 'it' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced: boolean; locale: string | null };
    expect(body).toEqual({ synced: true, locale: 'it' });

    const [row] = await getDb()
      .select({ locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(row.locale).toBe('it');
  });

  it('a device with no bound user cannot write an account preference (synced: false), and never throws', async () => {
    const org = await seedOrg('loc-unbound');
    const token = 'device-token-unbound';
    await mintDevice(org.id, token);

    const res = await localePost({ request: bearer(token, { locale: 'it' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced: boolean; locale: string | null };
    expect(body).toEqual({ synced: false, locale: null });
  });
});

afterAll(async () => {
  await getPool().end();
});
