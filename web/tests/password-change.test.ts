import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { POST as changePassword } from '../src/routes/api/auth/password/+server.js';
import { POST as login } from '../src/routes/api/auth/login/+server.js';
import { type CookieJar, makeCookies, runThroughHandle } from './helpers/handle-harness.js';

const USERNAME = 'carol';
const PASSWORD = 'correct-horse-battery';
const WRONG = 'wrong-password-9999';
const NEW_PASSWORD = 'new-correct-battery-1';

// Captured at import time so afterAll can restore it and this file doesn't
// leak PITCHBOX_AUTH into other test files sharing this worker.
const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  await getDb().execute(sql`TRUNCATE auth_failures RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM sessions`);
  await getDb().execute(sql`DELETE FROM memberships`);
  await getDb().execute(sql`DELETE FROM users`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'auth_policy'`);
}

async function seedUser(): Promise<{ userId: number; passwordHash: string }> {
  const hash = await hashPassword(PASSWORD);
  const [row] = await getDb()
    .insert(schema.users)
    .values({ username: USERNAME, passwordHash: hash })
    .returning();
  let [org] = await getDb()
    .select()
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  if (!org) {
    [org] = await getDb()
      .insert(schema.organizations)
      .values({ slug: 'default', name: 'Default' })
      .returning();
  }
  await getDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: row.id, role: 'owner' })
    .onConflictDoNothing();
  return { userId: row.id, passwordHash: row.passwordHash };
}

function changeRequest(body: unknown) {
  return new Request('http://localhost/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function attemptLogin(username: string, password: string, ip: string) {
  const jar: CookieJar = { store: new Map() };
  return login({
    request: new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    cookies: makeCookies(jar) as any,
    getClientAddress: () => ip,
  } as any);
}

describe('self-service password change', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  it('refuses a wrong current password and leaves the stored hash unchanged', async () => {
    const { userId, passwordHash } = await seedUser();
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };

    const res = await runThroughHandle(
      changeRequest({ currentPassword: WRONG, newPassword: NEW_PASSWORD }),
      jar,
      changePassword as any,
      '10.5.0.1',
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid_credentials' });

    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row.passwordHash).toBe(passwordHash);
  });

  it('a correct change retires the old password and admits the new one, through the real login handler', async () => {
    const { userId } = await seedUser();
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };

    const res = await runThroughHandle(
      changeRequest({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      jar,
      changePassword as any,
      '10.5.0.2',
    );
    expect(res.status).toBe(200);

    const oldLogin = await attemptLogin(USERNAME, PASSWORD, '10.5.0.3');
    expect(oldLogin.status).toBe(401);

    const newLogin = await attemptLogin(USERNAME, NEW_PASSWORD, '10.5.0.4');
    expect(newLogin.status).toBe(200);
  });

  it('revokes every other session but keeps the one that made the change', async () => {
    const { userId } = await seedUser();
    const currentSession = await createSession(getDb(), userId);
    const otherSession = await createSession(getDb(), userId);
    const jar: CookieJar = {
      store: new Map([['pitchbox_session', { value: currentSession.id }]]),
    };

    const res = await runThroughHandle(
      changeRequest({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      jar,
      changePassword as any,
      '10.5.0.5',
    );
    expect(res.status).toBe(200);

    const remaining = await getDb()
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId));
    expect(remaining.map((r) => r.id)).toEqual([currentSession.id]);

    const otherStillThere = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, otherSession.id));
    expect(otherStillThere.length).toBe(0);
  });

  it('shares the login lockout bucket: 5 wrong current-password guesses lock out login too', async () => {
    const { userId } = await seedUser();
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };

    for (let i = 0; i < 5; i++) {
      const r = await runThroughHandle(
        changeRequest({ currentPassword: WRONG, newPassword: NEW_PASSWORD }),
        jar,
        changePassword as any,
        '10.5.0.6',
      );
      expect(r.status).toBe(401);
    }

    const loginRes = await attemptLogin(USERNAME, PASSWORD, '10.5.0.6');
    expect(loginRes.status).toBe(429);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
});
