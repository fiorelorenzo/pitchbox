import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../../../lib/server/db.js';
import {
  clearAuthFailures,
  consumePasswordResetToken,
  createSession,
  getLockoutUntil,
  hashPassword,
  loadAuthPolicy,
  recordAuthFailure,
} from '@pitchbox/shared/auth';

const COOKIE = 'pitchbox_session';

const Body = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});

/**
 * Completes a password reset (#509): redeems the single-use token minted by
 * POST /api/auth/password/forgot, sets the new password, and - unlike the
 * self-service change at POST /api/auth/password, which keeps the caller's
 * own session alive - drops every session for the account, including any
 * the caller might already be holding. Whoever reset the password may be
 * recovering from a compromise; nothing from before this request should
 * still be trusted. The caller ends up signed in through a session minted
 * fresh by this request, not one that survived from before it.
 */
export async function POST(event: RequestEvent) {
  if (process.env.PITCHBOX_AUTH !== 'on') {
    throw error(404, 'auth_disabled');
  }
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
  const ipBucket = `reset:ip:${ip}`;
  const policy = await loadAuthPolicy(db);
  const now = new Date();
  const ipLock = await getLockoutUntil(db, ipBucket, policy, now);
  if (ipLock) {
    return json(
      {
        error: 'rate_limited',
        retry_after_seconds: Math.max(1, Math.ceil((ipLock.getTime() - now.getTime()) / 1000)),
      },
      { status: 429 },
    );
  }

  // Unknown, already-used, and expired all answer identically - same
  // reasoning as the forgot endpoint not distinguishing a known address
  // from an unknown one.
  const userId = await consumePasswordResetToken(db, parsed.data.token);
  if (!userId) {
    await recordAuthFailure(db, ipBucket, 'password_reset_confirm');
    return json({ error: 'invalid_or_expired_token' }, { status: 400 });
  }

  const [user] = await db
    .select({ username: schema.users.username, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user) {
    return json({ error: 'invalid_or_expired_token' }, { status: 400 });
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await db.update(schema.users).set({ passwordHash: newHash }).where(eq(schema.users.id, userId));

  // Every session gone, not just "every other one" - there is no session
  // making this request to spare, and any that survived from before a
  // possible compromise should not either.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));

  // Whoever just proved control of the mailbox shouldn't still be locked
  // out by whatever failed login attempts sent them to this flow in the
  // first place (#509). Clears the login bucket, this reset flow's own
  // per-address bucket, and the IP bucket that gated this very request.
  await Promise.all([
    clearAuthFailures(db, `user:${user.username}`),
    clearAuthFailures(db, ipBucket),
    ...(user.email ? [clearAuthFailures(db, `reset:email:${user.email}`)] : []),
  ]);

  const session = await createSession(db, userId);
  event.cookies.set(COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: session.expiresAt,
  });
  return json({ ok: true });
}
