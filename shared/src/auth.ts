import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  appConfig,
  authFailures,
  emailVerificationTokens,
  passwordResetTokens,
  sessions,
  users,
  organizations,
  memberships,
} from './db/schema.js';
import { defaultOrgName } from './orgs.js';
import { ensurePersonalProject } from './personal-project.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export type AuthPolicy = {
  maxAttempts: number;
  windowMinutes: number;
  lockoutMinutes: number;
};

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  maxAttempts: 5,
  windowMinutes: 5,
  lockoutMinutes: 15,
};

const AUTH_POLICY_KEY = 'auth_policy';

function clampPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function loadAuthPolicy(db: Db): Promise<AuthPolicy> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, AUTH_POLICY_KEY));
  const value = rows[0]?.value as Partial<Record<string, unknown>> | undefined;
  if (!value || typeof value !== 'object') return DEFAULT_AUTH_POLICY;
  return {
    maxAttempts: clampPositiveInt(value.max_attempts, DEFAULT_AUTH_POLICY.maxAttempts),
    windowMinutes: clampPositiveInt(value.window_minutes, DEFAULT_AUTH_POLICY.windowMinutes),
    lockoutMinutes: clampPositiveInt(value.lockout_minutes, DEFAULT_AUTH_POLICY.lockoutMinutes),
  };
}

export async function recordAuthFailure(
  db: Db,
  identifier: string,
  kind = 'login_attempt',
): Promise<void> {
  // One row per attempt against a bucket (IP or the caller's own
  // identifier) - the counter checks each bucket independently. `kind`
  // defaults to the original login-attempt label so the two existing call
  // sites (login, password change) are unaffected; the forgot/reset-
  // password routes (#509) pass their own kind so an admin reading
  // listRecentAuthFailures can tell a mail-bomb attempt on the reset flow
  // apart from a credential-guessing attempt on login.
  await db.insert(authFailures).values({ identifier, kind });
}

export async function countAuthFailuresSince(
  db: Db,
  identifier: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ id: authFailures.id })
    .from(authFailures)
    .where(and(eq(authFailures.identifier, identifier), gt(authFailures.failedAt, since)));
  return rows.length;
}

/**
 * Returns the lockout expiry (in ms since epoch) if `identifier` is currently
 * locked out - i.e. has at least `maxAttempts` failures in the rolling window
 * and the most recent failure is within `lockoutMinutes`. Otherwise null.
 */
export async function getLockoutUntil(
  db: Db,
  identifier: string,
  policy: AuthPolicy,
  now: Date = new Date(),
): Promise<Date | null> {
  const windowStart = new Date(now.getTime() - policy.windowMinutes * 60 * 1000);
  const rows = await db
    .select({ failedAt: authFailures.failedAt })
    .from(authFailures)
    .where(and(eq(authFailures.identifier, identifier), gt(authFailures.failedAt, windowStart)))
    .orderBy(desc(authFailures.failedAt))
    .limit(policy.maxAttempts);
  if (rows.length < policy.maxAttempts) return null;
  const newest = rows[0].failedAt as Date;
  const lockoutEnd = new Date(newest.getTime() + policy.lockoutMinutes * 60 * 1000);
  if (lockoutEnd <= now) return null;
  return lockoutEnd;
}

export async function clearAuthFailures(db: Db, identifier: string): Promise<number> {
  const result = await db
    .delete(authFailures)
    .where(eq(authFailures.identifier, identifier))
    .returning({ id: authFailures.id });
  return result.length;
}

export async function listRecentAuthFailures(
  db: Db,
  limit = 50,
): Promise<Array<{ id: number; identifier: string; failedAt: Date; kind: string }>> {
  const rows = await db
    .select()
    .from(authFailures)
    .orderBy(desc(authFailures.failedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    identifier: r.identifier,
    failedAt: r.failedAt as Date,
    kind: r.kind,
  }));
}

export async function pruneAuthFailures(db: Db, olderThan: Date): Promise<void> {
  await db.delete(authFailures).where(sql`${authFailures.failedAt} < ${olderThan}`);
}

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LEN);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = await scrypt(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  userId: number,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function loadSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  id: string,
): Promise<{ userId: number; username: string; activeOrganizationId: number | null } | null> {
  const rows = await db
    .select({
      userId: sessions.userId,
      username: users.username,
      activeOrganizationId: sessions.activeOrganizationId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  id: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function setSessionActiveOrg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  sessionId: string,
  organizationId: number,
): Promise<void> {
  await db
    .update(sessions)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessions.id, sessionId));
}

export async function countUsers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

/** Trims and lowercases an email so every write and lookup compares the same normalized form. Empty/absent collapses to null. */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Inserts a user row only - no org membership, no default-org bootstrap.
 * `createUser` below is for the two paths (first login, `seed:owner`) that
 * always want the `default` org as owner; `POST /api/auth/register` (#504)
 * must not go through that path (createUser would make every invited or
 * self-registered person an owner of the single-tenant `default` org - see
 * #503's write-up of that trap), so it composes this with `acceptInvite` or
 * `createOrganization` itself, inside its own transaction.
 */
export async function createUserRecord(
  db: Db,
  args: {
    username: string;
    password: string;
    email?: string | null;
    // Set only by POST /api/auth/register when an invite carried this exact
    // address (#514) - the inviter already vouched for it, so the account is
    // born verified rather than going through the mail round trip. Every
    // other caller (createUser's first-login/seed:owner bootstrap, a
    // token-only registration) leaves this null.
    emailVerifiedAt?: Date | null;
  },
): Promise<number> {
  const passwordHash = await hashPassword(args.password);
  const [row] = await db
    .insert(users)
    .values({
      username: args.username,
      passwordHash,
      email: normalizeEmail(args.email),
      emailVerifiedAt: args.emailVerifiedAt ?? null,
    })
    .returning();
  return row.id;
}

export async function createUser(
  db: Db,
  args: {
    username: string;
    password: string;
    email?: string | null;
    isInstanceAdmin?: boolean;
  },
): Promise<number> {
  const userId = await createUserRecord(db, {
    username: args.username,
    password: args.password,
    email: args.email,
  });
  // The only place that writes `is_instance_admin` true is setInstanceAdmin
  // below (#413): routing the bootstrap grant through it too means there is
  // exactly one function to audit or extend, not a second insert-time path
  // that can quietly drift from the promote path.
  if (args.isInstanceAdmin) {
    await setInstanceAdmin(db, userId, true);
  }
  // First user implicitly joins the default org as owner. If the default org
  // doesn't exist yet (fresh install without seed:core), create it inline.
  let [org] = await db.select().from(organizations).where(eq(organizations.slug, 'default'));
  const orgName = defaultOrgName(args.username);
  if (!org) {
    [org] = await db.insert(organizations).values({ slug: 'default', name: orgName }).returning();
  } else if (org.name === 'Default' || org.name === 'My Organization') {
    // The first real user takes over the seeded placeholder name.
    await db.update(organizations).set({ name: orgName }).where(eq(organizations.id, org.id));
  }
  // Every organization needs its `personal` project (shared/src/personal-
  // project.ts, decision 2026-09-07). Idempotent, so this is a harmless
  // no-op on the common path where seed:core already created it; it only
  // does real work on the fresh-install path just above, where the default
  // org itself was just created inline.
  await ensurePersonalProject(db, org.id);
  await db
    .insert(memberships)
    .values({ organizationId: org.id, userId, role: 'owner' })
    .onConflictDoNothing();
  return userId;
}

/**
 * Flip a user's instance-admin flag. The single write site for
 * `users.is_instance_admin` (#413): `createUser` calls this for the
 * bootstrap grant (first-login or `seed:owner`) instead of setting the
 * column on insert, and the promote-a-user API route calls it directly for
 * every grant after the first account has already claimed the flag. One
 * function means one place to audit, not two write paths that can drift.
 */
export async function setInstanceAdmin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  userId: number,
  value: boolean,
): Promise<void> {
  await db.update(users).set({ isInstanceAdmin: value }).where(eq(users.id, userId));
}

/**
 * List every user with their instance-admin flag, ordered by username. Backs
 * the `settings/admin` observability list (#413): without the instance audit
 * trail (#414), this is the only way to confirm a promotion from the UI
 * instead of the database.
 */
export async function listUsers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
): Promise<{ id: number; username: string; isInstanceAdmin: boolean }[]> {
  return db
    .select({ id: users.id, username: users.username, isInstanceAdmin: users.isInstanceAdmin })
    .from(users)
    .orderBy(users.username);
}

export async function loadOrganizationForUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  userId: number,
): Promise<{ id: number; slug: string; role: string } | null> {
  const rows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserByUsername(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  username: string,
): Promise<{ id: number; passwordHash: string } | null> {
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ id: number; passwordHash: string } | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  return rows[0] ?? null;
}

// 20 minutes: inside the 15-30 minute window #509 calls for. Short enough
// that a link sitting in an inbox for hours is dead by the time anyone but
// the intended recipient could use it; long enough that fetching mail on a
// slow connection doesn't race it.
const RESET_TOKEN_TTL_MS = 20 * 60 * 1000;

/**
 * Mints a single-use, time-limited password reset token for `userId` and
 * stores only its hash (`password_reset_tokens.token_hash`). Structurally
 * this is org_invites' shape - a random token, an expiry, a single-use
 * marker - but hashed at rest like extension_devices.token_hash
 * (web/src/lib/server/extension-auth.ts's `hashToken`/`mintDeviceToken`):
 * org_invites stores its token in the clear, which is fine for a link an
 * org admin hands out on purpose, but wrong for a credential that proves
 * control of an arbitrary mailbox. The raw token is returned once here and
 * is not recoverable from the row afterward.
 */
export async function createPasswordResetToken(
  db: Db,
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await db
    .insert(passwordResetTokens)
    .values({ userId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt });
  return { token, expiresAt };
}

/**
 * Atomically redeems a reset token: a single UPDATE that only matches a row
 * still unused and unexpired, in the same statement that marks it used -
 * the same compare-and-set shape the extension device rotate endpoint uses
 * (web/src/routes/api/extension/rotate/+server.ts) against a concurrent
 * second rotate, applied here against a concurrent second redemption of the
 * same reset link. Returns the owning user id, or null for an unknown,
 * already-used, or expired token - the caller must answer all three
 * identically so a probe can't learn which one it hit.
 */
export async function consumePasswordResetToken(db: Db, token: string): Promise<number | null> {
  const [row] = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, createHash('sha256').update(token).digest('hex')),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: passwordResetTokens.userId });
  return row?.userId ?? null;
}

// 48 hours, not the 20-minute window RESET_TOKEN_TTL_MS uses above: #514
// asks for the TTL "measured in hours rather than minutes since people read
// mail late" - a stale reset link is a bigger risk to leave lying around
// (it changes a password) than a stale verification link is (it only
// proves a mailbox, and the account already works for everything but
// starting a run in the meantime).
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Mints a single-use, time-limited email verification token for `userId`
 * and stores only its hash (`email_verification_tokens.token_hash`) -
 * exactly `createPasswordResetToken`'s shape above, reused rather than
 * reinvented since both are "prove control of this mailbox" tokens. The raw
 * token is returned once here and is not recoverable from the row
 * afterward.
 */
export async function createEmailVerificationToken(
  db: Db,
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);
  await db.insert(emailVerificationTokens).values({
    userId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Atomically redeems a verification token: a single UPDATE that only
 * matches a row still unused and unexpired, in the same statement that
 * marks it used - same compare-and-set shape as
 * `consumePasswordResetToken`. Returns the owning user id, or null for an
 * unknown, already-used, or expired token; the caller answers all three
 * identically, same reasoning as the reset flow.
 */
export async function consumeEmailVerificationToken(db: Db, token: string): Promise<number | null> {
  const [row] = await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, createHash('sha256').update(token).digest('hex')),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: emailVerificationTokens.userId });
  return row?.userId ?? null;
}

/** Marks `userId`'s address verified. The one write site for `users.email_verified_at`. */
export async function markEmailVerified(db: Db, userId: number): Promise<void> {
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

/**
 * Whether `userId` may do whatever `requireVerifiedEmail`
 * (web/src/lib/server/auth.ts) gates - today, starting a run (#514). An
 * account with no email on file predates the #507 requirement (first-login
 * bootstrap, `seed:owner`, the CLI) and can never clear this column, so it
 * is treated as verified rather than permanently locked out; only an
 * account that has an address is held to actually proving it.
 */
export async function isEmailVerified(db: Db, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return false;
  if (!row.email) return true;
  return row.emailVerifiedAt != null;
}
