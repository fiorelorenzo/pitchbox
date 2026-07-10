import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { createSession, setSessionActiveOrg } from '@pitchbox/shared/auth';
import { POST as extensionPairingPost } from '../src/routes/api/settings/extension-pairing/+server.js';
import { POST as extensionPairConsume } from '../src/routes/api/extension/pair/+server.js';
import { GET as extensionDevicesGet } from '../src/routes/api/settings/extension-devices/+server.js';

/**
 * Task 13c Part 2 regression: extension device/pairing org attribution on the
 * WRITE side must follow the caller's active org, not a hardcoded default org
 * (extension-pairing POST) and not just the user's first membership
 * (auto-pair GET, which used the deprecated loadOrganizationForUser).
 */

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM extension_pairings`);
  await db.execute(sql`DELETE FROM extension_devices`);
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

function orgLocalsEvent(orgId: number): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
  } as unknown as RequestEvent;
}

describe('extension device/pairing org attribution', () => {
  beforeEach(reset);

  describe('POST /api/settings/extension-pairing -> POST /api/extension/pair -> GET /api/settings/extension-devices', () => {
    it('attributes the paired device to the caller active org, not the hardcoded default org, and only that org can see it', async () => {
      const db = getDb();
      const [orgA] = await db
        .insert(schema.organizations)
        .values({ slug: 'edo-a', name: 'edo-a' })
        .returning();
      const [orgB] = await db
        .insert(schema.organizations)
        .values({ slug: 'edo-b', name: 'edo-b' })
        .returning();
      const [defaultOrg] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, 'default'));

      const pairRes = await extensionPairingPost(orgLocalsEvent(orgA.id));
      const { code } = (await pairRes.json()) as { code: string };

      const [pairingRow] = await db
        .select({ organizationId: schema.extensionPairings.organizationId })
        .from(schema.extensionPairings)
        .where(eq(schema.extensionPairings.code, code));
      expect(pairingRow.organizationId).toBe(orgA.id);
      expect(pairingRow.organizationId).not.toBe(defaultOrg?.id);

      const consumeRes = await extensionPairConsume({
        request: new Request('http://x/api/extension/pair', {
          method: 'POST',
          body: JSON.stringify({ code }),
        }),
      } as unknown as Parameters<typeof extensionPairConsume>[0]);
      expect(consumeRes.status).toBe(200);

      const devicesA = (await (await extensionDevicesGet(orgLocalsEvent(orgA.id))).json()) as {
        devices: { id: number }[];
      };
      const devicesB = (await (await extensionDevicesGet(orgLocalsEvent(orgB.id))).json()) as {
        devices: { id: number }[];
      };
      expect(devicesA.devices.length).toBe(1);
      expect(devicesB.devices.map((d) => d.id)).not.toContain(devicesA.devices[0].id);
    });
  });

  describe('GET /api/extension/auto-pair', () => {
    it('attributes the device to the session active org, not the user first membership', async () => {
      process.env.PITCHBOX_AUTH = 'on';
      // The route reads PITCHBOX_AUTH into a module-level constant at import
      // time, so it must be set before the module is (dynamically) imported.
      const { GET: autoPairGet } = await import('../src/routes/api/extension/auto-pair/+server.js');

      const db = getDb();
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'edo-user', passwordHash: 'x' })
        .returning();
      const [orgFirst] = await db
        .insert(schema.organizations)
        .values({ slug: 'edo-first', name: 'edo-first' })
        .returning();
      const [orgActive] = await db
        .insert(schema.organizations)
        .values({ slug: 'edo-active', name: 'edo-active' })
        .returning();
      // orgFirst is inserted first, so the deprecated loadOrganizationForUser
      // (LIMIT 1, no ORDER BY on activeOrganizationId) would resolve to it;
      // the fix must instead honor the session's chosen active org.
      await db.insert(schema.memberships).values([
        { organizationId: orgFirst.id, userId: user.id, role: 'owner' },
        { organizationId: orgActive.id, userId: user.id, role: 'owner' },
      ]);
      const session = await createSession(db, user.id);
      await setSessionActiveOrg(db, session.id, orgActive.id);

      const res = await autoPairGet({
        cookies: { get: (n: string) => (n === 'pitchbox_session' ? session.id : undefined) },
        request: new Request('http://x/api/extension/auto-pair'),
      } as unknown as Parameters<typeof autoPairGet>[0]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deviceId: number };

      const [device] = await db
        .select({ organizationId: schema.extensionDevices.organizationId })
        .from(schema.extensionDevices)
        .where(eq(schema.extensionDevices.id, body.deviceId));
      expect(device.organizationId).toBe(orgActive.id);
      expect(device.organizationId).not.toBe(orgFirst.id);
    });
  });
});

afterAll(async () => {
  await getPool().end();
});
