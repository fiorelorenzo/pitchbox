import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { createInvite } from '@pitchbox/shared/orgs';
import { load, actions } from '../src/routes/invite/[token]/+page.server.js';

const acceptInviteAction = actions.default as (
  event: Parameters<typeof load>[0],
) => Promise<unknown>;

/**
 * The invite `load` runs on a plain GET navigation (e.g. an attacker-embedded
 * img/iframe), so it must never mutate state. Accepting an invite requires an
 * explicit POST to the form action. Regression test for that split.
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

async function membershipExists(orgId: number, userId: number) {
  const [m] = await getDb()
    .select()
    .from(schema.memberships)
    .where(sql`user_id = ${userId} AND organization_id = ${orgId}`);
  return !!m;
}

function loadEvent(token: string, userId: number): Parameters<typeof load>[0] {
  return {
    params: { token },
    url: new URL(`http://x/invite/${token}`),
    locals: { user: { id: userId, username: 'invitee' } },
  } as unknown as Parameters<typeof load>[0];
}

function actionEvent(token: string, userId: number): Parameters<typeof load>[0] {
  return {
    params: { token },
    url: new URL(`http://x/invite/${token}`),
    locals: { user: { id: userId, username: 'invitee' } },
    request: new Request('http://x/', { method: 'POST' }),
  } as unknown as Parameters<typeof load>[0];
}

describe('invite acceptance requires an explicit POST', () => {
  beforeEach(reset);

  it('does not create a membership on GET load, only previews the invite', async () => {
    const orgId = await seedOrg('csrf-org');
    const adminId = await seedUser('csrf-admin');
    const inviteeId = await seedUser('csrf-invitee');
    const inv = await createInvite(getDb(), { organizationId: orgId, createdByUserId: adminId });

    const data = (await load(loadEvent(inv.token, inviteeId))) as {
      ok: boolean;
      org?: { name: string };
    };

    expect(data.ok).toBe(true);
    expect(await membershipExists(orgId, inviteeId)).toBe(false);
  });

  it('creates a membership when the form action is posted', async () => {
    const orgId = await seedOrg('csrf-org-2');
    const adminId = await seedUser('csrf-admin-2');
    const inviteeId = await seedUser('csrf-invitee-2');
    const inv = await createInvite(getDb(), { organizationId: orgId, createdByUserId: adminId });

    await expect(acceptInviteAction(actionEvent(inv.token, inviteeId))).rejects.toMatchObject({
      status: 302,
      location: '/',
    });

    expect(await membershipExists(orgId, inviteeId)).toBe(true);
  });

  it('the action rejects an invalid or expired token without throwing a redirect', async () => {
    const inviteeId = await seedUser('csrf-invitee-3');
    const result = await acceptInviteAction(actionEvent('not-a-real-token', inviteeId));
    expect((result as { status: number }).status).toBe(400);
  });
});
