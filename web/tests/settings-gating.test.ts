import { describe, expect, it, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { load as retentionLoad } from '../src/routes/settings/retention/+page.server.js';
import { load as securityLoad } from '../src/routes/settings/security/+page.server.js';
import { POST as unlockPost } from '../src/routes/api/auth/unlock/+server.js';
import { GET as failuresGet } from '../src/routes/api/auth/failures/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';

// Captured at import time (before `runThroughHandle` below can set it to
// 'on') so afterAll can restore it and this file doesn't leak PITCHBOX_AUTH
// into other test files sharing this worker.
const originalAuth = process.env.PITCHBOX_AUTH;

// requireRole reads locals.org.role. PITCHBOX_AUTH is unset in the test env, so
// requireSession (in the unlock endpoint) is a no-op and requireRole is the gate.
function loaderEvent(role: string | null): RequestEvent {
  return {
    locals: role ? { org: { id: 1, slug: 'default', role } } : {},
  } as unknown as RequestEvent;
}

function unlockEvent(role: string | null, body: unknown): RequestEvent {
  return {
    locals: role ? { org: { id: 1, slug: 'default', role } } : {},
    cookies: { get: () => undefined },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as RequestEvent;
}

// Cast the generated PageServerLoad signatures down to a plain RequestEvent,
// same as retention-role.test.ts does for the form action: the $types are
// route-specific (ServerLoadEvent adds parent/depends/untrack) and don't accept
// a hand-built RequestEvent otherwise.
const retention = retentionLoad as (
  event: RequestEvent,
) => Promise<{ policy: unknown; floor: number }>;
const security = securityLoad as (
  event: RequestEvent,
) => Promise<{ policy: unknown; failures: unknown[] }>;

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

// Ensures a user exists in the default org with the given role and returns a
// cookie jar carrying a live session for them, for driving requests through
// the real hooks.server handle() below. Idempotent so re-running this file
// against a persisted test DB doesn't hit unique-username conflicts.
async function sessionFor(username: string, role: 'member' | 'admin'): Promise<CookieJar> {
  const hash = await hashPassword(PASSWORD);
  await getDb().insert(schema.users).values({ username, passwordHash: hash }).onConflictDoNothing();
  const [user] = await getDb()
    .select()
    .from(schema.users)
    .where(sql`username = ${username}`);
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
    .values({ organizationId: org.id, userId: user.id, role })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { role },
    });
  const session = await createSession(getDb(), user.id);
  return { store: new Map([['pitchbox_session', { value: session.id }]]) };
}

// Toggling PITCHBOX_AUTH here is separate from hooks.server.ts's own cached
// AUTH_ON constant (module-level, set at import time): the unlock/failures
// route handlers read process.env.PITCHBOX_AUTH live on every call via their
// own `requireSession` defence-in-depth check, so this is safe regardless of
// whether `runThroughHandle` (below) has already imported hooks.server with
// auth on.
async function withAuthOff<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.PITCHBOX_AUTH;
  delete process.env.PITCHBOX_AUTH;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.PITCHBOX_AUTH;
    else process.env.PITCHBOX_AUTH = original;
  }
}

describe('settings gating', () => {
  describe('retention load', () => {
    it('a member is forbidden (403)', async () => {
      expect(await statusOf(() => retention(loaderEvent('member')))).toBe(403);
    });
    it('an admin can load the policy', async () => {
      const data = await retention(loaderEvent('admin'));
      expect(data.policy).toBeDefined();
      expect(typeof data.floor).toBe('number');
    });
  });

  describe('security load', () => {
    it('a member is forbidden (403)', async () => {
      expect(await statusOf(() => security(loaderEvent('member')))).toBe(403);
    });
    it('an admin can load the failures list', async () => {
      const data = await security(loaderEvent('admin'));
      expect(data.policy).toBeDefined();
      expect(Array.isArray(data.failures)).toBe(true);
    });
  });

  // These two endpoints are exactly what ISO-1 (#132) hid: hooks.server.ts's
  // `isExemptPath` used to exempt every `/api/auth/*` route from session +
  // org/role resolution, including `/api/auth/unlock` and `/api/auth/failures`
  // (only `/login` and `/logout` should be exempt), so `requireRole` had no
  // `locals.org` to gate on in production. A hand-injected `locals.org` (as
  // above) can't catch that, because the hook never runs and never gets the
  // chance to leave `locals.org` unset - so these are driven through the real
  // `handle()` hook instead.
  describe('POST /api/auth/unlock (via real handle)', () => {
    it('a member session is forbidden (403)', async () => {
      const jar = await sessionFor('gating-member', 'member');
      const req = new Request('http://localhost/api/auth/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'someone' }),
      });
      await expect(runThroughHandle(req, jar, unlockPost as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an admin session can unlock (200)', async () => {
      const jar = await sessionFor('gating-admin', 'admin');
      const req = new Request('http://localhost/api/auth/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'someone' }),
      });
      const res = await runThroughHandle(req, jar, unlockPost as any);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });

    it('auth off (no org context) has full access (200)', async () => {
      await withAuthOff(async () => {
        const res = await unlockPost(unlockEvent(null, { username: 'someone' }));
        expect(res.status).toBe(200);
      });
    });
  });

  describe('GET /api/auth/failures (via real handle)', () => {
    it('a member session is forbidden (403)', async () => {
      const jar = await sessionFor('gating-member-2', 'member');
      const req = new Request('http://localhost/api/auth/failures');
      await expect(runThroughHandle(req, jar, failuresGet as any)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('an admin session can read the failures list (200)', async () => {
      const jar = await sessionFor('gating-admin-2', 'admin');
      const req = new Request('http://localhost/api/auth/failures');
      const res = await runThroughHandle(req, jar, failuresGet as any);
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json()).failures)).toBe(true);
    });

    it('auth off (no org context) has full access (200)', async () => {
      await withAuthOff(async () => {
        const res = await failuresGet(loaderEvent(null));
        expect(res.status).toBe(200);
      });
    });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
