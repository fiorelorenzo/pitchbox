import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '../../../../../lib/server/db.js';
import {
  createPasswordResetToken,
  findUserByEmail,
  getLockoutUntil,
  loadAuthPolicy,
  normalizeEmail,
  recordAuthFailure,
} from '@pitchbox/shared/auth';
import { createMailTransport } from '@pitchbox/shared/mail/registry';
import { loadMailEnv } from '@pitchbox/shared/mail/env';
import { renderPlainTextMail } from '@pitchbox/shared/mail/template';

const Body = z.object({
  email: z.string().trim().pipe(z.email()),
});

/**
 * Requests a password reset link for `email` (#509). Always answers 200
 * with the same body whether or not the address belongs to an account -
 * distinguishing the two turns this endpoint into a way to test which
 * addresses have a Pitchbox account, which is exactly what
 * `findUserByEmail` returning null must never surface to the caller.
 *
 * Rate-limited by IP and by the submitted address through the same
 * auth_failures table login uses, so repeatedly requesting a reset for
 * someone else's real address can't be used to mail-bomb their inbox.
 */
export async function POST(event: RequestEvent) {
  if (process.env.PITCHBOX_AUTH !== 'on') {
    throw error(404, 'auth_disabled');
  }
  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const email = normalizeEmail(parsed.data.email);
  if (!email) throw error(400, 'invalid_body');

  const db = getDb();
  let ip: string;
  try {
    ip = event.getClientAddress() || 'unknown';
  } catch {
    ip = 'unknown';
  }
  const ipBucket = `reset:ip:${ip}`;
  const addressBucket = `reset:email:${email}`;
  const policy = await loadAuthPolicy(db);
  const now = new Date();
  const [ipLock, addressLock] = await Promise.all([
    getLockoutUntil(db, ipBucket, policy, now),
    getLockoutUntil(db, addressBucket, policy, now),
  ]);
  const lockedUntil =
    ipLock && addressLock ? (ipLock > addressLock ? ipLock : addressLock) : (ipLock ?? addressLock);
  if (lockedUntil) {
    return json(
      {
        error: 'rate_limited',
        retry_after_seconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
      },
      { status: 429 },
    );
  }

  // Counts this request against both buckets regardless of what happens
  // next - an unknown address still costs the caller one of their attempts,
  // otherwise probing addresses that don't exist would be unthrottled.
  await Promise.all([
    recordAuthFailure(db, ipBucket, 'password_reset_request'),
    recordAuthFailure(db, addressBucket, 'password_reset_request'),
  ]);

  const user = await findUserByEmail(db, email);
  if (user) {
    const { token } = await createPasswordResetToken(db, user.id);
    const resetUrl = `${event.url.origin}/reset/${token}`;
    const rendered = renderPlainTextMail(
      'Reset your Pitchbox password',
      `Someone asked to reset the password on this Pitchbox account.\n\n` +
        `Open this link within 20 minutes to choose a new one:\n${resetUrl}\n\n` +
        `If this wasn't you, ignore this message - your password stays the same.`,
    );
    const transport = createMailTransport(loadMailEnv());
    await transport.send({ to: email, ...rendered });
  }

  return json({ ok: true });
}
