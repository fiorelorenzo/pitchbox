import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { POST as login } from '../src/routes/api/auth/login/+server.js';
import { POST as logout } from '../src/routes/api/auth/logout/+server.js';
import { POST as unlock } from '../src/routes/api/auth/unlock/+server.js';
import { GET as listFailures } from '../src/routes/api/auth/failures/+server.js';

const USERNAME = 'alice';
const PASSWORD = 'correct-horse-battery';
const WRONG = 'wrong-password-9999';

// Captured at import time so afterAll can restore it and this file doesn't
// leak PITCHBOX_AUTH into other test files sharing this worker.
const originalAuth = process.env.PITCHBOX_AUTH;

// hooks.server.ts reads PITCHBOX_AUTH into a module-level constant at import
// time, so it must be `on` before the module is (dynamically) imported - a
// static top-of-file import would evaluate before beforeEach sets it. Cached
// after the first call since the module (and its captured env) is a singleton.
let handlePromise: Promise<typeof import('../src/hooks.server.js').handle> | undefined;
function getHandle() {
  if (!handlePromise) {
    process.env.PITCHBOX_AUTH = 'on';
    handlePromise = import('../src/hooks.server.js').then((m) => m.handle);
  }
  return handlePromise;
}

async function reset() {
  await getDb().execute(sql`TRUNCATE auth_failures RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM sessions`);
  await getDb().execute(sql`DELETE FROM memberships`);
  await getDb().execute(sql`DELETE FROM users`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'auth_policy'`);
}

async function seedUser() {
  const hash = await hashPassword(PASSWORD);
  const [row] = await getDb()
    .insert(schema.users)
    .values({ username: USERNAME, passwordHash: hash })
    .returning();
  // First user needs an org/membership for `loadOrganizationForUser` parity,
  // though the login route itself doesn't require it.
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
  return row.id;
}

// Seeds a second user in the same default org with the given role, for
// testing role-gated endpoints against a non-owner caller.
async function seedUserWithRole(username: string, role: 'member' | 'admin'): Promise<number> {
  const hash = await hashPassword(PASSWORD);
  const [row] = await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash })
    .returning();
  const [org] = await getDb()
    .select()
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  await getDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: row.id, role })
    .onConflictDoNothing();
  return row.id;
}

type CookieJar = {
  store: Map<string, { value: string; expires?: Date }>;
};

function makeCookies(jar: CookieJar) {
  return {
    get: (name: string) => jar.store.get(name)?.value,
    set: (name: string, value: string, opts?: { expires?: Date }) => {
      jar.store.set(name, { value, expires: opts?.expires });
    },
    delete: (name: string) => {
      jar.store.delete(name);
    },
    getAll: () => Array.from(jar.store.entries()).map(([name, v]) => ({ name, value: v.value })),
    serialize: () => '',
  };
}

function makeEvent(body: unknown, jar: CookieJar, ip = '10.0.0.1') {
  const request = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,

    cookies: makeCookies(jar) as any,
    getClientAddress: () => ip,
  } as any;
}

async function callLogin(body: unknown, jar: CookieJar, ip = '10.0.0.1'): Promise<Response> {
  return await login(makeEvent(body, jar, ip));
}

// Drives a request through the real `handle()` hook (the actual auth +
// org-resolution code path), then hands off to the real route handler with
// whatever `event.locals` the hook populated - no hand-fabricated
// `locals.org`, which is what let the role-gate bug hide before.
async function runThroughHandle(
  request: Request,
  jar: CookieJar,
  routeHandler: (event: unknown) => Promise<Response>,
  ip = '10.0.0.2',
): Promise<Response> {
  const event = {
    request,
    url: new URL(request.url),
    cookies: makeCookies(jar) as any,
    locals: {} as any,
    getClientAddress: () => ip,
  };
  const handle = await getHandle();
  return await handle({
    event: event as any,
    resolve: async (ev: typeof event) => routeHandler(ev),
  } as any);
}

describe('auth hardening', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
    await seedUser();
  });

  it('returns generic invalid_credentials for unknown user', async () => {
    const jar: CookieJar = { store: new Map() };
    const res = await callLogin({ username: 'ghost', password: WRONG }, jar);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid_credentials' });
  });

  it('returns the same generic body for wrong password', async () => {
    const jar: CookieJar = { store: new Map() };
    const res = await callLogin({ username: USERNAME, password: WRONG }, jar);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid_credentials' });
  });

  it('locks out after 5 failed attempts within the window', async () => {
    const jar: CookieJar = { store: new Map() };
    for (let i = 0; i < 5; i++) {
      const r = await callLogin({ username: USERNAME, password: WRONG }, jar);
      expect(r.status).toBe(401);
    }
    // 6th attempt is rate-limited even if password were correct.
    const sixth = await callLogin({ username: USERNAME, password: PASSWORD }, jar);
    expect(sixth.status).toBe(429);
    const body = await sixth.json();
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it('rotates the session id on successful login', async () => {
    const jar: CookieJar = { store: new Map() };
    // Seed a pre-existing session for the user so we can verify it's dropped.
    const userId = (
      await getDb()
        .select()
        .from(schema.users)
        .where(sql`username = ${USERNAME}`)
    )[0].id;
    const prev = await createSession(getDb(), userId);
    jar.store.set('pitchbox_session', { value: prev.id });

    const res = await callLogin({ username: USERNAME, password: PASSWORD }, jar);
    expect(res.status).toBe(200);
    const newCookie = jar.store.get('pitchbox_session');
    expect(newCookie).toBeTruthy();
    expect(newCookie!.value).not.toBe(prev.id);

    // Old session id must be deleted.
    const stillThere = await getDb()
      .select()
      .from(schema.sessions)
      .where(sql`id = ${prev.id}`);
    expect(stillThere.length).toBe(0);
  });

  it('unlock endpoint clears failures for a username', async () => {
    const jar: CookieJar = { store: new Map() };
    for (let i = 0; i < 5; i++) {
      await callLogin({ username: USERNAME, password: WRONG }, jar);
    }
    // Sanity: locked.
    let r = await callLogin({ username: USERNAME, password: PASSWORD }, jar);
    expect(r.status).toBe(429);

    // Create a session for the owner seeded by seedUser() and drive the
    // request through the real hooks.server handle() so locals.org is
    // resolved by the actual org-lookup code, not hand-fabricated.
    const userId = (
      await getDb()
        .select()
        .from(schema.users)
        .where(sql`username = ${USERNAME}`)
    )[0].id;
    const session = await createSession(getDb(), userId);
    const adminJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: session.id }]]),
    };

    const unlockReq = new Request('http://localhost/api/auth/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERNAME }),
    });
    const unlockRes = await runThroughHandle(unlockReq, adminJar, unlock as any);
    expect(unlockRes.status).toBe(200);
    const body = await unlockRes.json();
    expect(body.cleared).toBeGreaterThanOrEqual(5);

    // Username bucket cleared, but IP bucket still trips the lockout. Use a
    // fresh IP to confirm credentials work post-unlock.
    r = await callLogin({ username: USERNAME, password: PASSWORD }, jar, '10.9.9.9');
    expect(r.status).toBe(200);
  });

  it('failures endpoint returns recent attempts', async () => {
    const jar: CookieJar = { store: new Map() };
    await callLogin({ username: USERNAME, password: WRONG }, jar);
    const userId = (
      await getDb()
        .select()
        .from(schema.users)
        .where(sql`username = ${USERNAME}`)
    )[0].id;
    const session = await createSession(getDb(), userId);
    const adminJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: session.id }]]),
    };
    const req = new Request('http://localhost/api/auth/failures');
    const res = await runThroughHandle(req, adminJar, listFailures as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.failures)).toBe(true);
    expect(body.failures.length).toBeGreaterThanOrEqual(2); // both ip: and user: rows
  });

  it('a member session is denied unlocking a locked account (403)', async () => {
    const memberId = await seedUserWithRole('mallory', 'member');
    const session = await createSession(getDb(), memberId);
    const memberJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: session.id }]]),
    };

    const unlockReq = new Request('http://localhost/api/auth/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERNAME }),
    });
    await expect(runThroughHandle(unlockReq, memberJar, unlock as any)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('a member session is denied reading the auth-failures log (403)', async () => {
    const memberId = await seedUserWithRole('mallory', 'member');
    const session = await createSession(getDb(), memberId);
    const memberJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: session.id }]]),
    };

    const req = new Request('http://localhost/api/auth/failures');
    await expect(runThroughHandle(req, memberJar, listFailures as any)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('an admin session can unlock and read the auth-failures log', async () => {
    const adminId = await seedUserWithRole('bob', 'admin');
    const session = await createSession(getDb(), adminId);
    const adminJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: session.id }]]),
    };

    const failuresReq = new Request('http://localhost/api/auth/failures');
    const failuresRes = await runThroughHandle(failuresReq, adminJar, listFailures as any);
    expect(failuresRes.status).toBe(200);

    const unlockReq = new Request('http://localhost/api/auth/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERNAME }),
    });
    const unlockRes = await runThroughHandle(unlockReq, adminJar, unlock as any);
    expect(unlockRes.status).toBe(200);
  });

  it('logout deletes the session row', async () => {
    const jar: CookieJar = { store: new Map() };
    const res = await callLogin({ username: USERNAME, password: PASSWORD }, jar);
    expect(res.status).toBe(200);
    const sid = jar.store.get('pitchbox_session')!.value;

    const out = await logout({
      cookies: makeCookies(jar) as any,
    });
    expect(out.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(schema.sessions)
      .where(sql`id = ${sid}`);
    expect(rows.length).toBe(0);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
