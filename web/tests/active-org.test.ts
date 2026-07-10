import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  listUserOrganizations,
  loadActiveOrganization,
  createOrganization,
} from '@pitchbox/shared/orgs';

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedUser(username: string) {
  const [u] = await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: 'x' })
    .returning();
  return u.id;
}
async function seedOrgMember(slug: string, userId: number, role = 'member') {
  const db = getDb();
  const [o] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  await db.insert(schema.memberships).values({ organizationId: o.id, userId, role });
  return o.id;
}

describe('active-org resolution', () => {
  beforeEach(reset);

  it('lists all organizations a user belongs to', async () => {
    const uid = await seedUser('u1');
    const a = await seedOrgMember('ao-a', uid, 'owner');
    const b = await seedOrgMember('ao-b', uid, 'member');
    const orgs = await listUserOrganizations(getDb(), uid);
    expect(orgs.map((o) => o.id).sort()).toEqual([a, b].sort());
    expect(orgs.find((o) => o.id === a)?.role).toBe('owner');
  });

  it('returns the preferred org when the user is a member', async () => {
    const uid = await seedUser('u2');
    await seedOrgMember('ao-c', uid);
    const b = await seedOrgMember('ao-d', uid);
    const org = await loadActiveOrganization(getDb(), uid, b);
    expect(org?.id).toBe(b);
  });

  it('falls back to the first org when the preferred org is not a membership', async () => {
    const uid = await seedUser('u3');
    const a = await seedOrgMember('ao-e', uid);
    const org = await loadActiveOrganization(getDb(), uid, 999999);
    expect(org?.id).toBe(a);
  });

  it('returns null when the user has no membership', async () => {
    const uid = await seedUser('u4');
    expect(await loadActiveOrganization(getDb(), uid, null)).toBeNull();
  });

  it('creates an org with an owner membership', async () => {
    const uid = await seedUser('u5');
    const org = await createOrganization(getDb(), {
      slug: 'ao-new',
      name: 'New',
      ownerUserId: uid,
    });
    expect(org.role).toBe('owner');
    const orgs = await listUserOrganizations(getDb(), uid);
    expect(orgs.some((o) => o.id === org.id)).toBe(true);
  });
});
