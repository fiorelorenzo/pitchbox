import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { getDb, schema } from '../../../../lib/server/db.js';
import {
  clearAuthFailures,
  getLockoutUntil,
  hashPassword,
  loadAuthPolicy,
  recordAuthFailure,
  verifyPassword,
} from '@pitchbox/shared/auth';

const COOKIE = 'pitchbox_session';

// Same rule /api/auth/login enforces on `password`: a changed password can
// never end up weaker than login would have accepted for a fresh sign-in.
// `currentPassword` only needs to be present - it's checked against the
// stored hash, not a fresh password policy.
const Body = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

/**
 * Self-service password change for the signed-in caller. hooks.server.ts
 * already resolves `locals.user` for this route - only /api/auth/login and
 * /api/auth/logout are exempt from session resolution (#132) - so the
 * `!user` check below is defense in depth, same convention as
 * /api/auth/unlock and /api/auth/failures.
 */
export async function POST(event: RequestEvent) {
  if (process.env.PITCHBOX_AUTH !== 'on') {
    throw error(404, 'auth_disabled');
  }
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');

  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  let ip: string;
  try {
    ip = event.getClientAddress() || 'unknown';
  } catch {
    ip = 'unknown';
  }
  // Reuse the exact buckets /api/auth/login writes to. A wrong
  // current-password guess here is the same credential-guessing login
  // already throttles, so the two share one lockout window instead of this
  // endpoint being a second, unthrottled way to brute-force a password.
  const ipBucket = `ip:${ip}`;
  const userBucket = `user:${user.username}`;
  const policy = await loadAuthPolicy(db);
  const now = new Date();
  const [ipLock, userLock] = await Promise.all([
    getLockoutUntil(db, ipBucket, policy, now),
    getLockoutUntil(db, userBucket, policy, now),
  ]);
  const lockedUntil =
    ipLock && userLock ? (ipLock > userLock ? ipLock : userLock) : (ipLock ?? userLock);
  if (lockedUntil) {
    return json(
      {
        error: 'rate_limited',
        retry_after_seconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
      },
      { status: 429 },
    );
  }

  const [row] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, user.id));
  if (!row) throw error(404, 'not_found');

  const ok = await verifyPassword(parsed.data.currentPassword, row.passwordHash);
  if (!ok) {
    await recordAuthFailure(db, ipBucket);
    await recordAuthFailure(db, userBucket);
    return json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // Same counter reset login does on success, so a legitimate change doesn't
  // leave the caller sitting near the lockout threshold.
  await Promise.all([clearAuthFailures(db, ipBucket), clearAuthFailures(db, userBucket)]);

  const newHash = await hashPassword(parsed.data.newPassword);
  await db.update(schema.users).set({ passwordHash: newHash }).where(eq(schema.users.id, user.id));

  // Session decision: revoke every OTHER session for this user; the one
  // making this request stays alive. A password change is the standard
  // response to "someone else might know my old password" - if that's true
  // they may also be holding a live session minted under it, and leaving
  // sessions alone would mean the change stops nothing for them. The
  // caller's own session survives so changing your password doesn't also
  // sign you out of the tab you did it from.
  const currentSessionId = event.cookies.get(COOKIE);
  await db
    .delete(schema.sessions)
    .where(
      currentSessionId
        ? and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, currentSessionId))
        : eq(schema.sessions.userId, user.id),
    );

  return json({ ok: true });
}
