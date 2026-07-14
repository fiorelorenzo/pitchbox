import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { listOrgMembers, listPendingInvites, revokeInvite } from '@pitchbox/shared/orgs';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM org_invites`);
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
async function seedOrg(slug: string) {
  const [o] = await getDb().insert(schema.organizations).values({ slug, name: slug }).returning();
  return o.id;
}

describe('org member + invite helpers', () => {
  beforeEach(reset);

  it('listOrgMembers returns each membership with the username', async () => {
    const orgId = await seedOrg('om-a');
    const u1 = await seedUser('alice');
    const u2 = await seedUser('bob');
    const db = getDb();
    await db.insert(schema.memberships).values([
      { organizationId: orgId, userId: u1, role: 'owner' },
      { organizationId: orgId, userId: u2, role: 'member' },
    ]);
    const members = await listOrgMembers(db, orgId);
    expect(members).toHaveLength(2);
    const byName = Object.fromEntries(members.map((m) => [m.username, m.role]));
    expect(byName).toEqual({ alice: 'owner', bob: 'member' });
    expect(members[0]).toHaveProperty('userId');
    expect(members[0]).toHaveProperty('createdAt');
  });

  it('listPendingInvites returns only unaccepted, unexpired invites for the org', async () => {
    const orgId = await seedOrg('om-b');
    const other = await seedOrg('om-c');
    const db = getDb();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(schema.orgInvites).values([
      { organizationId: orgId, token: 'pending1', role: 'member', expiresAt: future },
      {
        organizationId: orgId,
        token: 'accepted1',
        role: 'admin',
        expiresAt: future,
        acceptedAt: new Date(),
      },
      { organizationId: orgId, token: 'expired1', role: 'member', expiresAt: past },
      { organizationId: other, token: 'otherorg', role: 'member', expiresAt: future },
    ]);
    const invites = await listPendingInvites(db, orgId);
    expect(invites.map((i) => i.token)).toEqual(['pending1']);
    expect(invites[0].role).toBe('member');
  });

  it('revokeInvite deletes a pending invite scoped to the org and reports success', async () => {
    const orgId = await seedOrg('om-d');
    const other = await seedOrg('om-e');
    const db = getDb();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(schema.orgInvites).values([
      { organizationId: orgId, token: 'tok-own', role: 'member', expiresAt: future },
      { organizationId: other, token: 'tok-foreign', role: 'member', expiresAt: future },
    ]);
    // wrong org cannot revoke another org's invite
    expect(await revokeInvite(db, orgId, 'tok-foreign')).toBe(false);
    // owning org revokes it
    expect(await revokeInvite(db, orgId, 'tok-own')).toBe(true);
    expect((await listPendingInvites(db, orgId)).length).toBe(0);
    // revoking again is a no-op
    expect(await revokeInvite(db, orgId, 'tok-own')).toBe(false);
    // the foreign invite is untouched
    expect((await listPendingInvites(db, other)).map((i) => i.token)).toEqual(['tok-foreign']);
  });
});
