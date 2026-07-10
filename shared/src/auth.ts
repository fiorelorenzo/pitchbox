import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  appConfig,
  authFailures,
  sessions,
  users,
  organizations,
  memberships,
} from './db/schema.js';

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

export async function recordAuthFailure(db: Db, identifier: string): Promise<void> {
  // Two rows per failed attempt - one keyed by IP, one by username - so the
  // counter can check either bucket independently.
  await db.insert(authFailures).values({ identifier, kind: 'login_attempt' });
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

export async function createUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  username: string,
  password: string,
): Promise<number> {
  const passwordHash = await hashPassword(password);
  const [row] = await db.insert(users).values({ username, passwordHash }).returning();
  // First user implicitly joins the default org as owner. If the default org
  // doesn't exist yet (fresh install without seed:core), create it inline.
  let [org] = await db.select().from(organizations).where(eq(organizations.slug, 'default'));
  if (!org) {
    [org] = await db.insert(organizations).values({ slug: 'default', name: 'Default' }).returning();
  }
  await db
    .insert(memberships)
    .values({ organizationId: org.id, userId: row.id, role: 'owner' })
    .onConflictDoNothing();
  return row.id;
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
