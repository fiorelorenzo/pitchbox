import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '../../../../../lib/server/db.js';
import {
  consumeEmailVerificationToken,
  getLockoutUntil,
  loadAuthPolicy,
  markEmailVerified,
  recordAuthFailure,
} from '@pitchbox/shared/auth';

const Body = z.object({
  token: z.string().min(1),
});

/**
 * Redeems a single-use email verification token minted by registration
 * (POST /api/auth/register) or a resend (POST /api/auth/verify/resend),
 * and sets `users.email_verified_at`. Exempt from session resolution in
 * hooks.server.ts, same as POST /api/auth/password/reset: the link may be
 * opened in a browser with no session at all (a different device, or the
 * one that registered having since signed out).
 *
 * Rate-limited by IP only, same shape as password/reset - the token itself
 * is the secret here, not an address, so there is no second bucket to
 * throttle. Unknown, already-used, and expired all answer identically:
 * `400 { "error": "invalid_or_expired_token" }`.
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
  const ipBucket = `verify:ip:${ip}`;
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

  const userId = await consumeEmailVerificationToken(db, parsed.data.token);
  if (!userId) {
    await recordAuthFailure(db, ipBucket, 'email_verify_attempt');
    return json({ error: 'invalid_or_expired_token' }, { status: 400 });
  }

  await markEmailVerified(db, userId);
  return json({ ok: true });
}
