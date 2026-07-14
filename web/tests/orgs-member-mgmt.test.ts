import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { getMemberRole } from '@pitchbox/shared/orgs';
import { PATCH, DELETE } from '../src/routes/api/orgs/[slug]/members/[userId]/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function setup() {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug: 'mm', name: 'mm' })
    .returning();
  async function u(username: string, role: string) {
    const [x] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
    await db.insert(schema.memberships).values({ organizationId: org.id, userId: x.id, role });
    return x.id;
  }
  return {
    orgId: org.id,
    slug: 'mm',
    owner: await u('own', 'owner'),
    owner2: await u('own2', 'owner'),
    admin: await u('adm', 'admin'),
    member: await u('mem', 'member'),
  };
}

function ev(actorId: number, slug: string, target: number, body?: unknown): RequestEvent {
  return {
    locals: { user: { id: actorId, username: 'x' } },
    params: { slug, userId: String(target) },
    request: new Request('http://x/', {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    }),
    url: new URL('http://x/'),
  } as unknown as RequestEvent;
}

describe('member management endpoints', () => {
  beforeEach(reset);

  describe('PATCH role change', () => {
    it('owner promotes a member to admin', async () => {
      const s = await setup();
      const res = await PATCH(ev(s.owner, s.slug, s.member, { role: 'admin' }));
      expect(res.status).toBe(200);
      expect(await getMemberRole(getDb(), s.orgId, s.member)).toBe('admin');
    });
    it('admin cannot grant owner', async () => {
      const s = await setup();
      const res = await PATCH(ev(s.admin, s.slug, s.member, { role: 'owner' }));
      expect(res.status).toBe(403);
      expect(await getMemberRole(getDb(), s.orgId, s.member)).toBe('member');
    });
    it('admin cannot demote an owner', async () => {
      const s = await setup();
      const res = await PATCH(ev(s.admin, s.slug, s.owner2, { role: 'member' }));
      expect(res.status).toBe(403);
      expect(await getMemberRole(getDb(), s.orgId, s.owner2)).toBe('owner');
    });
    it('owner can promote a member to owner', async () => {
      const s = await setup();
      const res = await PATCH(ev(s.owner, s.slug, s.member, { role: 'owner' }));
      expect(res.status).toBe(200);
      expect(await getMemberRole(getDb(), s.orgId, s.member)).toBe('owner');
    });
    it('rejects changing your own role', async () => {
      const s = await setup();
      const res = await PATCH(ev(s.owner, s.slug, s.owner, { role: 'admin' }));
      expect(res.status).toBe(400);
    });
    it('a plain member cannot change roles (404)', async () => {
      const s = await setup();
      const res = await PATCH(ev(s.member, s.slug, s.admin, { role: 'member' }));
      expect(res.status).toBe(404);
    });
    it('404 when the target is not a member', async () => {
      const s = await setup();
      const db = getDb();
      const [stranger] = await db
        .insert(schema.users)
        .values({ username: 'stranger', passwordHash: 'x' })
        .returning();
      const res = await PATCH(ev(s.owner, s.slug, stranger.id, { role: 'admin' }));
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE remove', () => {
    it('admin removes a member', async () => {
      const s = await setup();
      const res = await DELETE(ev(s.admin, s.slug, s.member));
      expect(res.status).toBe(200);
      expect(await getMemberRole(getDb(), s.orgId, s.member)).toBeNull();
    });
    it('admin cannot remove an owner', async () => {
      const s = await setup();
      const res = await DELETE(ev(s.admin, s.slug, s.owner2));
      expect(res.status).toBe(403);
      expect(await getMemberRole(getDb(), s.orgId, s.owner2)).toBe('owner');
    });
    it('rejects removing yourself', async () => {
      const s = await setup();
      const res = await DELETE(ev(s.owner, s.slug, s.owner));
      expect(res.status).toBe(400);
    });
    it('owner removes another owner (more than one owner remains fine)', async () => {
      const s = await setup();
      const res = await DELETE(ev(s.owner, s.slug, s.owner2));
      expect(res.status).toBe(200);
      expect(await getMemberRole(getDb(), s.orgId, s.owner2)).toBeNull();
    });
  });
});
