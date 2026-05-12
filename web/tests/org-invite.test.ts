import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { createInvite, acceptInvite, findValidInvite } from '@pitchbox/shared/orgs';

/**
 * Invite + accept produces a membership. Token is single-use: a second
 * accept returns null because acceptedAt is now set.
 */

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

describe('org invite flow', () => {
  beforeEach(reset);

  it('createInvite + acceptInvite creates a membership', async () => {
    const db = getDb();
    const orgId = await seedOrg('acme');
    const adminId = await seedUser('admin');
    const inviteeId = await seedUser('invitee');

    const inv = await createInvite(db, {
      organizationId: orgId,
      role: 'member',
      createdByUserId: adminId,
    });
    expect(inv.token).toMatch(/^[a-f0-9]{48}$/);

    const found = await findValidInvite(db, inv.token);
    expect(found?.organizationId).toBe(orgId);

    const accepted = await acceptInvite(db, inv.token, inviteeId);
    expect(accepted?.organizationId).toBe(orgId);
    expect(accepted?.role).toBe('member');

    const [m] = await db
      .select()
      .from(schema.memberships)
      .where(sql`user_id = ${inviteeId} AND organization_id = ${orgId}`);
    expect(m).toBeTruthy();
    expect(m.role).toBe('member');

    // Re-accepting the same token is a no-op (it is now marked accepted).
    const again = await acceptInvite(db, inv.token, inviteeId);
    expect(again).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const db = getDb();
    const orgId = await seedOrg('acme2');
    const adminId = await seedUser('admin2');
    const inviteeId = await seedUser('inv2');
    const inv = await createInvite(db, { organizationId: orgId, createdByUserId: adminId });
    // Force expiry into the past
    await db.execute(
      sql`UPDATE org_invites SET expires_at = now() - interval '1 day' WHERE token = ${inv.token}`,
    );
    const accepted = await acceptInvite(db, inv.token, inviteeId);
    expect(accepted).toBeNull();
  });
});
