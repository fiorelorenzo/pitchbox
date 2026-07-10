import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession } from '@pitchbox/shared/auth';
import { POST } from '../src/routes/api/orgs/switch/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

function event(sessionId: string, userId: number, body: unknown): RequestEvent {
  return {
    locals: { user: { id: userId, username: 'x' } },
    request: new Request('http://x/api/orgs/switch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    cookies: { get: (n: string) => (n === 'pitchbox_session' ? sessionId : undefined) },
  } as unknown as RequestEvent;
}

async function seed(username: string, slug: string, role = 'member') {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const [o] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  await db.insert(schema.memberships).values({ organizationId: o.id, userId: u.id, role });
  const s = await createSession(db, u.id);
  return { userId: u.id, orgId: o.id, sessionId: s.id };
}

describe('POST /api/orgs/switch', () => {
  beforeEach(reset);

  it('switches to an org the user belongs to', async () => {
    const a = await seed('sw1', 'sw-a');
    const db = getDb();
    const [b] = await db
      .insert(schema.organizations)
      .values({ slug: 'sw-b', name: 'B' })
      .returning();
    await db
      .insert(schema.memberships)
      .values({ organizationId: b.id, userId: a.userId, role: 'member' });

    const res = await POST(event(a.sessionId, a.userId, { organizationId: b.id }));
    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(schema.sessions)
      .where(sql`id = ${a.sessionId}`);
    expect(stored[0].activeOrganizationId).toBe(b.id);
  });

  it('rejects switching to an org the user is not a member of', async () => {
    const a = await seed('sw2', 'sw-c');
    const db = getDb();
    const [foreign] = await db
      .insert(schema.organizations)
      .values({ slug: 'sw-x', name: 'X' })
      .returning();
    await expect(
      POST(event(a.sessionId, a.userId, { organizationId: foreign.id })),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});
