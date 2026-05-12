import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '../../../../lib/server/db.js';
import {
  clearAuthFailures,
  countUsers,
  createSession,
  createUser,
  deleteSession,
  findUserByUsername,
  getLockoutUntil,
  loadAuthPolicy,
  recordAuthFailure,
  verifyPassword,
} from '@pitchbox/shared/auth';

const Body = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(256),
});

const COOKIE = 'pitchbox_session';

function clientIp(event: RequestEvent): string {
  try {
    return event.getClientAddress() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function POST(event: RequestEvent) {
  const { request, cookies } = event;
  if (process.env.PITCHBOX_AUTH !== 'on') {
    throw error(404, 'auth_disabled');
  }
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();

  const ip = clientIp(event);
  const ipBucket = `ip:${ip}`;
  const userBucket = `user:${parsed.data.username}`;
  const policy = await loadAuthPolicy(db);

  // Pre-check both rate-limit buckets. We deliberately use a generic error
  // body for failures so callers can't probe usernames via timing or message.
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

  let userId: number;
  const total = await countUsers(db);
  if (total === 0) {
    // First user becomes the admin on first login attempt.
    userId = await createUser(db, parsed.data.username, parsed.data.password);
  } else {
    const user = await findUserByUsername(db, parsed.data.username);
    if (!user) {
      await recordAuthFailure(db, ipBucket);
      await recordAuthFailure(db, userBucket);
      return json({ error: 'invalid_credentials' }, { status: 401 });
    }
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) {
      await recordAuthFailure(db, ipBucket);
      await recordAuthFailure(db, userBucket);
      return json({ error: 'invalid_credentials' }, { status: 401 });
    }
    userId = user.id;
  }

  // Session rotation: drop any previous session bound to the inbound cookie
  // before minting a fresh id. This thwarts session-fixation and ensures a
  // successful login always produces a new identifier.
  const prevCookie = cookies.get(COOKIE);
  if (prevCookie) {
    await deleteSession(db, prevCookie);
  }

  // Successful login also clears the failure counters so legitimate users
  // aren't penalised for a typo on retry.
  await Promise.all([clearAuthFailures(db, ipBucket), clearAuthFailures(db, userBucket)]);

  const session = await createSession(db, userId);
  cookies.set(COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: session.expiresAt,
  });
  return json({ ok: true });
}
