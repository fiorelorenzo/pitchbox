import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { defaultOrgName, findOrgBySlug, getMemberRole } from '@pitchbox/shared/orgs';
import { PATCH, DELETE } from '../src/routes/api/orgs/[slug]/+server.js';
import { POST as LEAVE } from '../src/routes/api/orgs/[slug]/leave/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrg(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  async function member(username: string, role: string) {
    const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
    await db.insert(schema.memberships).values({ organizationId: org.id, userId: u.id, role });
    return u.id;
  }
  return { orgId: org.id, slug, member };
}

function ev(userId: number, slug: string, body?: unknown): RequestEvent {
  return {
    locals: { user: { id: userId, username: 'x' } },
    params: { slug },
    request: new Request('http://x/', {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
    url: new URL('http://x/'),
  } as unknown as RequestEvent;
}

describe('org settings endpoints', () => {
  beforeEach(reset);

  it('defaultOrgName derives from username / email local part', () => {
    expect(defaultOrgName('alice')).toBe("alice's Organization");
    expect(defaultOrgName('tech@sencare.io')).toBe("tech's Organization");
  });

  describe('PATCH rename', () => {
    it('an admin renames the org', async () => {
      const o = await seedOrg('rn-a');
      const admin = await o.member('adm', 'admin');
      const res = await PATCH(ev(admin, o.slug, { name: 'Acme Inc.' }));
      expect(res.status).toBe(200);
      expect((await findOrgBySlug(getDb(), o.slug))?.name).toBe('Acme Inc.');
    });
    it('a member cannot rename (404)', async () => {
      const o = await seedOrg('rn-b');
      const mem = await o.member('mem', 'member');
      const res = await PATCH(ev(mem, o.slug, { name: 'Nope' }));
      expect(res.status).toBe(404);
    });
    it('rejects an empty name', async () => {
      const o = await seedOrg('rn-c');
      const owner = await o.member('own', 'owner');
      const res = await PATCH(ev(owner, o.slug, { name: '   ' }));
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE org', () => {
    it('an owner deletes a non-default org', async () => {
      const o = await seedOrg('dl-a');
      const owner = await o.member('own', 'owner');
      const res = await DELETE(ev(owner, o.slug));
      expect(res.status).toBe(200);
      expect(await findOrgBySlug(getDb(), o.slug)).toBeNull();
    });
    it('an admin cannot delete (owner only, 403)', async () => {
      const o = await seedOrg('dl-b');
      const admin = await o.member('adm', 'admin');
      const res = await DELETE(ev(admin, o.slug));
      expect(res.status).toBe(403);
      expect(await findOrgBySlug(getDb(), o.slug)).not.toBeNull();
    });
    it('the default org cannot be deleted (400)', async () => {
      const db = getDb();
      const def = await findOrgBySlug(db, 'default');
      const [u] = await db
        .insert(schema.users)
        .values({ username: 'du', passwordHash: 'x' })
        .returning();
      await db
        .insert(schema.memberships)
        .values({ organizationId: def!.id, userId: u.id, role: 'owner' })
        .onConflictDoNothing();
      const res = await DELETE(ev(u.id, 'default'));
      expect(res.status).toBe(400);
      expect(await findOrgBySlug(db, 'default')).not.toBeNull();
    });
  });

  describe('POST leave', () => {
    it('a member leaves the org', async () => {
      const o = await seedOrg('lv-a');
      await o.member('own', 'owner');
      const mem = await o.member('mem', 'member');
      const res = await LEAVE(ev(mem, o.slug));
      expect(res.status).toBe(200);
      expect(await getMemberRole(getDb(), o.orgId, mem)).toBeNull();
    });
    it('the sole owner cannot leave (400)', async () => {
      const o = await seedOrg('lv-b');
      const owner = await o.member('own', 'owner');
      const res = await LEAVE(ev(owner, o.slug));
      expect(res.status).toBe(400);
      expect(await getMemberRole(getDb(), o.orgId, owner)).toBe('owner');
    });
    it('one of two owners can leave', async () => {
      const o = await seedOrg('lv-c');
      const o1 = await o.member('own', 'owner');
      await o.member('own2', 'owner');
      const res = await LEAVE(ev(o1, o.slug));
      expect(res.status).toBe(200);
      expect(await getMemberRole(getDb(), o.orgId, o1)).toBeNull();
    });
  });
});
