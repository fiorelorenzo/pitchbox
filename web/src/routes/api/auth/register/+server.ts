import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '../../../../lib/server/db.js';
import {
  clearAuthFailures,
  createEmailVerificationToken,
  createSession,
  createUserRecord,
  deleteSession,
  findUserByEmail,
  findUserByUsername,
  getLockoutUntil,
  loadAuthPolicy,
  normalizeEmail,
  recordAuthFailure,
} from '@pitchbox/shared/auth';
import { createMailTransport } from '@pitchbox/shared/mail/registry';
import { loadMailEnv } from '@pitchbox/shared/mail/env';
import { renderPlainTextMail } from '@pitchbox/shared/mail/template';
import {
  acceptInvite,
  createOrganization,
  defaultOrgName,
  findValidInvite,
  uniqueOrgSlugFromUsername,
  type OrgInvite,
} from '@pitchbox/shared/orgs';
import { loadRegistrationPolicy } from '@pitchbox/shared/registration-policy';

// Same identifier/password shape as POST /api/auth/login (web/src/routes/api/
// auth/login/+server.ts) - one convention for both routes, per #504. Email is
// the one addition: required at registration (#507), since open sign-up
// (#505) makes it the only thing tying a self-registered account to a
// person, validated with the same z.email() the invites API already uses -
// trimmed first, so a pasted address with stray surrounding whitespace still
// passes format validation instead of failing before normalizeEmail() below
// ever gets a chance to clean it up.
const Body = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(256),
  email: z.string().trim().pipe(z.email()),
  // Present when the visitor arrived via /invite/<token>. Always
  // re-validated server-side against org_invites (findValidInvite) rather
  // than trusted from the client - see the transaction below.
  token: z.string().min(1).optional(),
});

const COOKIE = 'pitchbox_session';

// Thrown to unwind the transaction when the invite token stops being valid
// between the pre-check and the transactional accept (revoked, expired, or
// consumed by a concurrent request) - the account must never exist without
// the membership it was created for.
class InviteRaceError extends Error {}

function isUniqueViolation(e: unknown, constraintSubstring: string): boolean {
  const err = e as Error & {
    code?: string;
    cause?: Error & { code?: string; constraint?: string };
  };
  const code = err.code ?? err.cause?.code;
  const constraint = err.cause?.constraint ?? '';
  const msg = String(err.message ?? '');
  const causeMsg = String(err.cause?.message ?? '');
  return (
    code === '23505' &&
    (constraint.includes(constraintSubstring) ||
      msg.includes(constraintSubstring) ||
      causeMsg.includes(constraintSubstring))
  );
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

  let ip: string;
  try {
    ip = event.getClientAddress() || 'unknown';
  } catch {
    ip = 'unknown';
  }

  // Rate-limited by IP through the same auth_failures table and policy the
  // login route uses (loadAuthPolicy/getLockoutUntil/recordAuthFailure). No
  // per-identity bucket like login's `user:<username>`: every registration
  // attempt names a brand-new identity by definition, so bucketing by IP is
  // the one that actually slows down a spam/enumeration run.
  const ipBucket = `register:ip:${ip}`;
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

  // #505: the instance-wide switch, read fresh on every call so an operator
  // opening or closing registration from settings/admin takes effect
  // immediately, no redeploy. Checked before any other work so a probe
  // against a closed/invite-only deployment never reaches the uniqueness
  // checks below. Own error codes (not `invalid_credentials` or a bare 403)
  // so the page can explain what happened rather than show a generic
  // failure.
  const regPolicy = await loadRegistrationPolicy(db);
  if (regPolicy === 'off') {
    await recordAuthFailure(db, ipBucket);
    return json(
      {
        error: 'registration_closed',
        message: 'Registration is disabled on this deployment. Ask its operator for an account.',
      },
      { status: 403 },
    );
  }
  if (regPolicy === 'invite' && !parsed.data.token) {
    await recordAuthFailure(db, ipBucket);
    return json(
      {
        error: 'invite_required',
        message: 'This deployment is invite-only. Ask an organization owner for an invite link.',
      },
      { status: 403 },
    );
  }

  const email = normalizeEmail(parsed.data.email);
  if (!email) throw error(400, 'invalid_body');

  // Friendly pre-checks so a client gets a shape it can act on
  // (`username_taken` / `email_taken`) rather than a generic 500. The unique
  // indexes (`users_username_key`, `users_email_unique`) are still the real
  // guard against a concurrent registration racing this check - caught below.
  if (await findUserByUsername(db, parsed.data.username)) {
    await recordAuthFailure(db, ipBucket);
    return json({ error: 'username_taken' }, { status: 409 });
  }
  if (await findUserByEmail(db, email)) {
    await recordAuthFailure(db, ipBucket);
    return json({ error: 'email_taken' }, { status: 409 });
  }

  let invite: OrgInvite | null = null;
  if (parsed.data.token) {
    invite = await findValidInvite(db, parsed.data.token);
    if (!invite) {
      await recordAuthFailure(db, ipBucket);
      return json({ error: 'invalid_or_expired_invite' }, { status: 400 });
    }
  }

  // #514: the inviter already vouched for this address by naming it on the
  // invite, so a registration that supplies the exact same (normalized)
  // address is born verified - no mail round trip, no window where the
  // account can sign in but not run. An invite with no email on it, or one
  // whose email differs from what the registrant typed, gets the ordinary
  // unverified flow below.
  const inviteEmail = invite?.email ?? null;
  const inviteEmailMatches = inviteEmail != null && normalizeEmail(inviteEmail) === email;

  let userId: number;
  try {
    userId = await db.transaction(async (tx) => {
      // createUserRecord, not createUser: createUser unconditionally joins
      // the `default` org as owner, which would make every invited or
      // self-registered stranger an owner of the single-tenant self-host org
      // (#503's write-up of that trap). The account never exists without a
      // membership - both branches below add one in the same transaction.
      const id = await createUserRecord(tx, {
        username: parsed.data.username,
        password: parsed.data.password,
        email,
        emailVerifiedAt: inviteEmailMatches ? new Date() : null,
      });
      if (invite) {
        const accepted = await acceptInvite(tx, invite.token, id);
        if (!accepted) throw new InviteRaceError();
      } else {
        // #513: a stranger with no invite gets their own single-owner
        // organization, never `default` (the single-tenant self-host
        // fallback stays untouched either way), through the same
        // createOrganization primitive an already-logged-in user's `POST
        // /api/orgs` uses. `quotaSource: 'self_registration'` (#540) only
        // matters on self-host: this account has had zero human review, so
        // it starts on the lower self-registration default rather than the
        // shared org_quota_defaults an invited or manually-provisioned org
        // gets. On the cloud edition it does nothing - every fresh org
        // starts on the Free plan (#544, shared/src/plans.ts) regardless of
        // how it was created, since Free's own numbers are already the
        // low-trust ceiling this used to provide.
        const slug = await uniqueOrgSlugFromUsername(tx, parsed.data.username);
        await createOrganization(tx, {
          slug,
          name: defaultOrgName(parsed.data.username),
          ownerUserId: id,
          quotaSource: 'self_registration',
        });
      }
      return id;
    });
  } catch (e) {
    if (e instanceof InviteRaceError) {
      await recordAuthFailure(db, ipBucket);
      return json({ error: 'invalid_or_expired_invite' }, { status: 400 });
    }
    if (isUniqueViolation(e, 'users_username_key')) {
      await recordAuthFailure(db, ipBucket);
      return json({ error: 'username_taken' }, { status: 409 });
    }
    if (isUniqueViolation(e, 'users_email_unique')) {
      await recordAuthFailure(db, ipBucket);
      return json({ error: 'email_taken' }, { status: 409 });
    }
    throw e;
  }

  // Session rotation + cookie, identical to POST /api/auth/login.
  const prevCookie = cookies.get(COOKIE);
  if (prevCookie) {
    await deleteSession(db, prevCookie);
  }
  await clearAuthFailures(db, ipBucket);

  const session = await createSession(db, userId);
  cookies.set(COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: session.expiresAt,
  });

  // #514: exactly one verification mail per registration, and none at all
  // for the invite-matched case above (the account is already verified -
  // sending one anyway would be a mail promising a step that isn't there).
  // Same link-building convention as /api/auth/password/forgot: the
  // request's own origin, never a hardcoded host.
  if (!inviteEmailMatches) {
    const { token } = await createEmailVerificationToken(db, userId);
    const verifyUrl = `${event.url.origin}/verify/${token}`;
    const rendered = renderPlainTextMail(
      'Verify your Pitchbox email address',
      `Welcome to Pitchbox. Confirm this address to start running campaigns.\n\n` +
        `Open this link within 48 hours to verify:\n${verifyUrl}\n\n` +
        `You can sign in and look around before you verify - you just can't ` +
        `start a run yet. If you didn't create this account, ignore this message.`,
    );
    const transport = createMailTransport(loadMailEnv());
    await transport.send({ to: email, ...rendered });
  }

  return json({ ok: true, emailVerified: inviteEmailMatches });
}
