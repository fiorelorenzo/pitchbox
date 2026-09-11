import { json, error, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../../../lib/server/db.js';
import {
  createEmailVerificationToken,
  getLockoutUntil,
  loadAuthPolicy,
  recordAuthFailure,
} from '@pitchbox/shared/auth';
import { createMailTransport } from '@pitchbox/shared/mail/registry';
import { loadMailEnv } from '@pitchbox/shared/mail/env';
import { verifyEmailMail } from '@pitchbox/shared/mail/templates';

/**
 * Resends the verification mail for the signed-in caller's own account
 * (#514). Session-gated like POST /api/auth/password (self-service change) -
 * not exempt in hooks.server.ts, and defense-in-depth checked again here -
 * rather than taking an email in the body: the caller already proved who
 * they are by signing in, so there is nothing to enumerate and no reason to
 * make them retype an address.
 *
 * Rate-limited by IP and by the account's own address, reusing the same
 * `auth_failures` table and `loadAuthPolicy` register/login already use -
 * same dual-bucket shape as POST /api/auth/password/forgot.
 */
export async function POST(event: RequestEvent) {
  if (process.env.PITCHBOX_AUTH !== 'on') {
    throw error(404, 'auth_disabled');
  }
  const user = event.locals.user;
  if (!user) throw error(401, 'unauthenticated');

  const db = getDb();
  const [row] = await db
    .select({ email: schema.users.email, emailVerifiedAt: schema.users.emailVerifiedAt })
    .from(schema.users)
    .where(eq(schema.users.id, user.id));
  if (!row) throw error(404, 'not_found');
  if (!row.email) {
    return json({ error: 'no_email_on_file' }, { status: 400 });
  }
  if (row.emailVerifiedAt) {
    return json({ ok: true, alreadyVerified: true });
  }

  let ip: string;
  try {
    ip = event.getClientAddress() || 'unknown';
  } catch {
    ip = 'unknown';
  }
  const ipBucket = `verify:ip:${ip}`;
  const addressBucket = `verify:email:${row.email}`;
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

  // Counts this call against both buckets regardless of outcome, same
  // reasoning as forgot-password: a repeated resend costs the caller one of
  // their attempts even though the address is (by definition here) known.
  await Promise.all([
    recordAuthFailure(db, ipBucket, 'email_verify_resend'),
    recordAuthFailure(db, addressBucket, 'email_verify_resend'),
  ]);

  const { token } = await createEmailVerificationToken(db, user.id);
  const verifyUrl = `${event.url.origin}/verify/${token}`;
  // The caller is signed in, so `event.locals.locale` already carries this
  // account's own stored preference (hooks.server.ts's LOR-262 attach
  // point) rather than a guess - no separate lookup needed here, unlike
  // the forgot-password route where the request has no session behind it.
  const rendered = verifyEmailMail(event.locals.locale, 'resend', verifyUrl);
  const transport = createMailTransport(loadMailEnv());
  await transport.send({ to: row.email, ...rendered });

  return json({ ok: true });
}
