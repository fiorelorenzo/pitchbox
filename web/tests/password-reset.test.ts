import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession, hashPassword } from '@pitchbox/shared/auth';
import { POST as forgotPassword } from '../src/routes/api/auth/password/forgot/+server.js';
import { POST as resetPassword } from '../src/routes/api/auth/password/reset/+server.js';
import { POST as login } from '../src/routes/api/auth/login/+server.js';
import { type CookieJar, makeCookies, runThroughHandle } from './helpers/handle-harness.js';

const USERNAME = 'debra';
const EMAIL = 'debra@example.com';
const PASSWORD = 'correct-horse-battery';
const WRONG = 'wrong-password-9999';
const NEW_PASSWORD = 'brand-new-battery-1';

// Captured at import time so afterAll can restore it and this file doesn't
// leak PITCHBOX_AUTH into other test files sharing this worker.
const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE password_reset_tokens RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE auth_failures RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM app_config WHERE key = 'auth_policy'`);
}

async function seedUser(): Promise<{ userId: number }> {
  const db = getDb();
  const hash = await hashPassword(PASSWORD);
  const [row] = await db
    .insert(schema.users)
    .values({ username: USERNAME, passwordHash: hash, email: EMAIL })
    .returning();
  let [org] = await db
    .select()
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  if (!org) {
    [org] = await db
      .insert(schema.organizations)
      .values({ slug: 'default', name: 'Default' })
      .returning();
  }
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: row.id, role: 'owner' })
    .onConflictDoNothing();
  return { userId: row.id };
}

function forgotRequest(email: string) {
  return new Request('http://localhost/api/auth/password/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

function resetRequestBody(token: string, newPassword: string) {
  return new Request('http://localhost/api/auth/password/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
}

// Drives the real forgot-password route through the real handle(), and
// captures the reset link from the null transport's console.log - the same
// thing a person reading process logs on a self-host with nothing
// configured would see, and the only place the raw token exists once this
// call returns (shared/src/auth.ts never returns it a second time).
async function requestReset(
  email: string,
  ip = '10.9.0.1',
): Promise<{ res: Response; token: string | null; logged: string }> {
  const jar: CookieJar = { store: new Map() };
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  let res: Response;
  let logged: string;
  try {
    res = await runThroughHandle(
      forgotRequest(email),
      jar,
      // runThroughHandle's routeHandler is `(event: unknown) => Promise<Response>`
      // since it forwards whatever locals the real hook populated; the real
      // route declares the narrower RequestEvent the hook actually builds.
      (event) => forgotPassword(event as unknown as RequestEvent),
      ip,
    );
    logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    logSpy.mockRestore();
  }
  const match = logged.match(/\/reset\/([0-9a-f]+)/);
  return { res, token: match?.[1] ?? null, logged };
}

async function confirmReset(
  token: string,
  newPassword: string,
  ip = '10.9.1.1',
): Promise<{ res: Response; jar: CookieJar }> {
  const jar: CookieJar = { store: new Map() };
  const res = await runThroughHandle(
    resetRequestBody(token, newPassword),
    jar,
    (event) => resetPassword(event as unknown as RequestEvent),
    ip,
  );
  return { res, jar };
}

async function attemptLogin(username: string, password: string, ip: string) {
  const jar: CookieJar = { store: new Map() };
  const event = {
    request: new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    cookies: makeCookies(jar),
    getClientAddress: () => ip,
  };
  // Minimal RequestEvent stand-in: login() only reads request/cookies/
  // getClientAddress, same shape password-change.test.ts's attemptLogin uses.
  return login(event as unknown as RequestEvent);
}

describe('forgot/reset password', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  it('a session-less GET reaches /reset/<token> through the real handle(), not a login redirect', async () => {
    const jar: CookieJar = { store: new Map() };
    const dummyPage = async () => new Response('reset page', { status: 200 });
    const res = await runThroughHandle(
      new Request('http://localhost/reset/some-token', { method: 'GET' }),
      jar,
      dummyPage,
      '10.9.0.9',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reset page');
  });

  it('answers a known and an unknown address identically, and only mails the known one', async () => {
    await seedUser();
    const known = await requestReset(EMAIL, '10.9.1.10');
    const unknown = await requestReset('nobody@example.com', '10.9.1.11');

    expect(known.res.status).toBe(unknown.res.status);
    expect(await known.res.json()).toEqual(await unknown.res.json());
    expect(known.logged).toContain('would send');
    expect(unknown.logged).toBe('');
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const { userId } = await seedUser();
    const { token } = await requestReset(EMAIL, '10.9.2.10');
    expect(token).toBeTruthy();

    const [row] = await getDb()
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, userId));
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(createHash('sha256').update(token!).digest('hex'));
  });

  it('a token works exactly once - a second redemption is rejected', async () => {
    await seedUser();
    const { token } = await requestReset(EMAIL, '10.9.3.10');

    const first = await confirmReset(token!, NEW_PASSWORD, '10.9.3.11');
    expect(first.res.status).toBe(200);

    const second = await confirmReset(token!, 'yet-another-password-2', '10.9.3.12');
    expect(second.res.status).toBe(400);
    expect(await second.res.json()).toEqual({ error: 'invalid_or_expired_token' });
  });

  it('an expired token is refused', async () => {
    await seedUser();
    const { token } = await requestReset(EMAIL, '10.9.4.10');
    const tokenHash = createHash('sha256').update(token!).digest('hex');
    await getDb()
      .update(schema.passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.passwordResetTokens.tokenHash, tokenHash));

    const { res } = await confirmReset(token!, NEW_PASSWORD, '10.9.4.11');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_or_expired_token' });
  });

  it('a completed reset retires the old password, admits the new one, and revokes every existing session', async () => {
    const { userId } = await seedUser();
    const priorSession = await createSession(getDb(), userId);
    const { token } = await requestReset(EMAIL, '10.9.5.10');

    const { res, jar } = await confirmReset(token!, NEW_PASSWORD, '10.9.5.11');
    expect(res.status).toBe(200);

    const remaining = await getDb()
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId));
    // The prior session is gone; the only session left is the fresh one the
    // reset itself minted, matching the cookie the response set. Checked
    // before the login attempts below, since a successful login mints its
    // own session and would otherwise show up in this count too.
    expect(remaining.map((r) => r.id)).not.toContain(priorSession.id);
    const mintedSessionId = jar.store.get('pitchbox_session')?.value;
    expect(remaining.map((r) => r.id)).toEqual([mintedSessionId]);

    const oldLogin = await attemptLogin(USERNAME, PASSWORD, '10.9.5.12');
    expect(oldLogin.status).toBe(401);
    const newLogin = await attemptLogin(USERNAME, NEW_PASSWORD, '10.9.5.13');
    expect(newLogin.status).toBe(200);
  });

  it('clears the account login lockout on a completed reset, without touching an unrelated IP bucket', async () => {
    await seedUser();
    // Five wrong-password guesses against the account, each from a
    // different IP - only the per-user bucket crosses the threshold, no
    // single IP bucket does.
    for (let i = 0; i < 5; i++) {
      const r = await attemptLogin(USERNAME, WRONG, `10.9.6.${i}`);
      expect(r.status).toBe(401);
    }
    const stillLocked = await attemptLogin(USERNAME, PASSWORD, '10.9.6.90');
    expect(stillLocked.status).toBe(429);

    const { token } = await requestReset(EMAIL, '10.9.7.10');
    const { res } = await confirmReset(token!, NEW_PASSWORD, '10.9.7.11');
    expect(res.status).toBe(200);

    const afterReset = await attemptLogin(USERNAME, NEW_PASSWORD, '10.9.6.91');
    expect(afterReset.status).toBe(200);
  });

  it('rate limits repeated reset requests for the same address', async () => {
    await seedUser();
    for (let i = 0; i < 5; i++) {
      const { res } = await requestReset(EMAIL, `10.9.8.${i}`);
      expect(res.status).toBe(200);
    }
    const { res } = await requestReset(EMAIL, '10.9.8.90');
    expect(res.status).toBe(429);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
});
