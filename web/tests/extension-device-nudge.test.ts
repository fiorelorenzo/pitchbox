import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { getExtensionDeviceNudge } from '../src/lib/server/extension-sync.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Timestamps must be RELATIVE to now: the code-under-test flags an org as
// stale once none of its devices have shown activity for 14 days. A
// hardcoded calendar date rots the same way the sibling `hasChatUnauthorizedDevice`
// tests warn about - "recent" sits well inside the window, "stale" sits well
// outside it.
const recentDate = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
const staleDate = () => new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE extension_devices RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makeOrg(slug: string): Promise<number> {
  const [org] = await getDb().insert(schema.organizations).values({ slug, name: slug }).returning();
  return org.id;
}

describe('getExtensionDeviceNudge', () => {
  beforeEach(reset);

  it('nudges discovery when the org has never paired a device', async () => {
    const orgId = await makeOrg('edn-none');
    expect(await getExtensionDeviceNudge(orgId)).toEqual({ kind: 'no_device' });
  });

  it('returns null when a device has recently reported in', async () => {
    const orgId = await makeOrg('edn-fresh');
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        organizationId: orgId,
        label: 'fresh',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        lastSeenAt: recentDate(),
      });
    expect(await getExtensionDeviceNudge(orgId)).toBeNull();
  });

  it('nudges re-pair once every device has gone quiet past the staleness window', async () => {
    const orgId = await makeOrg('edn-stale');
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        organizationId: orgId,
        label: 'stale',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        lastSeenAt: staleDate(),
      });
    expect(await getExtensionDeviceNudge(orgId)).toEqual({ kind: 'stale_device' });
  });

  it('treats a freshly-paired device that has not synced yet as active, not stale', async () => {
    const orgId = await makeOrg('edn-new-pair');
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        organizationId: orgId,
        label: 'just paired',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        // No lastSeenAt yet - falls back to createdAt, which defaults to now,
        // so a device paired seconds ago must not immediately read as stale.
      });
    expect(await getExtensionDeviceNudge(orgId)).toBeNull();
  });

  it('ignores revoked devices, so a fully-revoked org reads as no_device', async () => {
    const orgId = await makeOrg('edn-revoked');
    await getDb()
      .insert(schema.extensionDevices)
      .values({
        organizationId: orgId,
        label: 'revoked',
        tokenHash: hashToken(randomBytes(16).toString('hex')),
        lastSeenAt: recentDate(),
        revokedAt: new Date(),
      });
    expect(await getExtensionDeviceNudge(orgId)).toEqual({ kind: 'no_device' });
  });

  it('picks the freshest device when an org has a mix of stale and fresh devices', async () => {
    const orgId = await makeOrg('edn-mixed');
    await getDb()
      .insert(schema.extensionDevices)
      .values([
        {
          organizationId: orgId,
          label: 'stale',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSeenAt: staleDate(),
        },
        {
          organizationId: orgId,
          label: 'fresh',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSeenAt: recentDate(),
        },
      ]);
    expect(await getExtensionDeviceNudge(orgId)).toBeNull();
  });

  it('is scoped per-org: another org going stale does not nudge this one', async () => {
    const orgA = await makeOrg('edn-scope-a');
    const orgB = await makeOrg('edn-scope-b');
    await getDb()
      .insert(schema.extensionDevices)
      .values([
        {
          organizationId: orgA,
          label: 'a-fresh',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSeenAt: recentDate(),
        },
        {
          organizationId: orgB,
          label: 'b-stale',
          tokenHash: hashToken(randomBytes(16).toString('hex')),
          lastSeenAt: staleDate(),
        },
      ]);
    expect(await getExtensionDeviceNudge(orgA)).toBeNull();
    expect(await getExtensionDeviceNudge(orgB)).toEqual({ kind: 'stale_device' });
  });
});

afterAll(async () => {
  await getPool().end();
});
