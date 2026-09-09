import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '../../../../lib/server/db.js';
import {
  clearAuthFailures,
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
      });
      if (invite) {
        const accepted = await acceptInvite(tx, invite.token, id);
        if (!accepted) throw new InviteRaceError();
      } else {
        // #513 owns the real self-registration org policy (slug source,
        // quota, role nuance, what an invited-later user keeps). This is a
        // narrow, unopinionated stand-in so open sign-up (#505) is not
        // accidentally invite-only in the meantime: every stranger gets
        // their own single-owner org through the existing createOrganization
        // primitive, never `default`.
        const slug = await uniqueOrgSlugFromUsername(tx, parsed.data.username);
        await createOrganization(tx, {
          slug,
          name: defaultOrgName(parsed.data.username),
          ownerUserId: id,
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
  return json({ ok: true });
}
