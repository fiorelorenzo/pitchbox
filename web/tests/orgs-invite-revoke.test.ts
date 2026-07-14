import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { listPendingInvites } from '@pitchbox/shared/orgs';
import { DELETE } from '../src/routes/api/orgs/[slug]/invites/[token]/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM org_invites`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seed(username: string, slug: string, role: string) {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const [o] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  if (role)
    await db.insert(schema.memberships).values({ organizationId: o.id, userId: u.id, role });
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db
    .insert(schema.orgInvites)
    .values({ organizationId: o.id, token: `${slug}-tok`, role: 'member', expiresAt: future });
  return { userId: u.id, orgId: o.id, slug };
}

function ev(userId: number | null, slug: string, token: string): RequestEvent {
  return {
    locals: { user: userId ? { id: userId, username: 'x' } : undefined },
    params: { slug, token },
    request: new Request('http://x/', { method: 'DELETE' }),
    url: new URL('http://x/'),
  } as unknown as RequestEvent;
}

describe('DELETE /api/orgs/[slug]/invites/[token]', () => {
  beforeEach(reset);

  it('an admin revokes a pending invite of their org', async () => {
    const a = await seed('admin1', 'rv-a', 'owner');
    const res = await DELETE(ev(a.userId, 'rv-a', 'rv-a-tok'));
    expect(res.status).toBe(200);
    expect((await listPendingInvites(getDb(), a.orgId)).length).toBe(0);
  });

  it('rejects a non-admin member with 404', async () => {
    const m = await seed('member1', 'rv-b', 'member');
    const res = await DELETE(ev(m.userId, 'rv-b', 'rv-b-tok'));
    expect(res.status).toBe(404);
    expect((await listPendingInvites(getDb(), m.orgId)).length).toBe(1);
  });

  it('rejects a non-member (different org admin cannot revoke) with 404', async () => {
    const a = await seed('admin2', 'rv-c', 'owner');
    const b = await seed('admin3', 'rv-d', 'owner');
    // admin of rv-d tries to revoke rv-c's invite via rv-c slug -> not a member of rv-c
    const res = await DELETE(ev(b.userId, 'rv-c', 'rv-c-tok'));
    expect(res.status).toBe(404);
    expect((await listPendingInvites(getDb(), a.orgId)).length).toBe(1);
  });
});
