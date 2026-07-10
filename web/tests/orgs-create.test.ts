import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession } from '@pitchbox/shared/auth';
import { POST } from '../src/routes/api/orgs/+server.js';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedUser(username: string) {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const s = await createSession(db, u.id);
  return { userId: u.id, sessionId: s.id };
}
function event(sessionId: string, userId: number, body: unknown): RequestEvent {
  return {
    locals: { user: { id: userId, username: 'x' } },
    request: new Request('http://x/api/orgs', { method: 'POST', body: JSON.stringify(body) }),
    cookies: { get: (n: string) => (n === 'pitchbox_session' ? sessionId : undefined) },
  } as unknown as RequestEvent;
}

describe('POST /api/orgs', () => {
  beforeEach(reset);

  it('creates an org, owner membership, and switches active org', async () => {
    const u = await seedUser('cr1');
    const res = await POST(event(u.sessionId, u.userId, { slug: 'cr-new', name: 'New Co' }));
    expect(res.status).toBe(201);
    const db = getDb();
    const [stored] = await db
      .select()
      .from(schema.sessions)
      .where(sql`id = ${u.sessionId}`);
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(sql`slug = 'cr-new'`);
    expect(stored.activeOrganizationId).toBe(org.id);
  });

  it('rejects a duplicate slug', async () => {
    const u = await seedUser('cr2');
    await POST(event(u.sessionId, u.userId, { slug: 'cr-dup', name: 'One' }));
    await expect(
      POST(event(u.sessionId, u.userId, { slug: 'cr-dup', name: 'Two' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an invalid slug', async () => {
    const u = await seedUser('cr3');
    await expect(
      POST(event(u.sessionId, u.userId, { slug: 'Bad Slug!', name: 'X' })),
    ).rejects.toMatchObject({ status: 400 });
  });
});
