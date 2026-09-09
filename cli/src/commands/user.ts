import { Command } from 'commander';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  createUser,
  findUserByUsername,
  hashPassword,
  clearAuthFailures,
} from '@pitchbox/shared/auth';
import { OwnerUsername, OwnerPassword } from './seed-owner.js';
import { readSecret } from '../lib/password.js';
import { ok, fail } from '../lib/output.js';

const PASSWORD_ENV = 'PITCHBOX_CLI_PASSWORD';
const PASSWORD_HELP =
  `Reads the password from ${PASSWORD_ENV}, or from stdin when it is piped ` +
  '(not a TTY), or prompts interactively with echo suppressed otherwise. ' +
  'Never pass a password as a command-line argument - it lands in shell ' +
  'history and is visible to every other process on the box via `ps`.';

export type UserCreateResult =
  | { created: true; userId: number; username: string; isInstanceAdmin: boolean }
  | { created: false; reason: 'user_exists'; message: string }
  | { created: false; reason: 'invalid_username' | 'invalid_password'; message: string };

// Same createUser() path seed:owner and the first-login bootstrap use, so
// hashing and the default-org owner membership never diverge between the
// three. Unlike seed:owner (which only ever runs on an empty users table),
// this can run against a deployment that already has users - createUser
// tolerates that: it only creates the `default` org if missing, and the
// membership insert is `onConflictDoNothing`, so a second account just joins
// the org that's already there.
export async function createUserCli(args: {
  username: string;
  password: string;
  admin: boolean;
}): Promise<UserCreateResult> {
  const usernameCheck = OwnerUsername.safeParse(args.username);
  if (!usernameCheck.success) {
    const message =
      'Invalid username: must be 1-64 characters, letters/digits/"_"/"."/"-" only.';
    return { created: false, reason: 'invalid_username', message };
  }
  const passwordCheck = OwnerPassword.safeParse(args.password);
  if (!passwordCheck.success) {
    const message = 'Invalid password: must be 8-256 characters.';
    return { created: false, reason: 'invalid_password', message };
  }

  const db = getDb();
  const existing = await findUserByUsername(db, args.username);
  if (existing) {
    return {
      created: false,
      reason: 'user_exists',
      message: `A user named "${args.username}" already exists. Use user:reset-password to recover it instead.`,
    };
  }

  const userId = await createUser(db, {
    username: args.username,
    password: args.password,
    isInstanceAdmin: args.admin,
  });
  return { created: true, userId, username: args.username, isInstanceAdmin: args.admin };
}

export type UserResetPasswordResult =
  | { reset: true; userId: number; username: string; sessionsRevoked: number }
  | { reset: false; reason: 'user_not_found'; message: string }
  | { reset: false; reason: 'invalid_password'; message: string };

// Same recovery a self-service password change performs (web/src/routes/api/
// auth/password/+server.ts): rehash, drop every session for the account (an
// operator resetting a password from the shell has no "this tab" session to
// spare the way the self-service route does), and clear the login-throttle
// bucket the login route keyed on this username, so the freshly-set password
// isn't immediately rejected as still-locked-out.
export async function resetPasswordCli(args: {
  username: string;
  password: string;
}): Promise<UserResetPasswordResult> {
  const passwordCheck = OwnerPassword.safeParse(args.password);
  if (!passwordCheck.success) {
    return {
      reset: false,
      reason: 'invalid_password',
      message: 'Invalid password: must be 8-256 characters.',
    };
  }

  const db = getDb();
  const user = await findUserByUsername(db, args.username);
  if (!user) {
    return {
      reset: false,
      reason: 'user_not_found',
      message: `No user named "${args.username}". Use user:create to add it instead.`,
    };
  }

  const passwordHash = await hashPassword(args.password);
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id));
  const revoked = await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, user.id))
    .returning({ id: schema.sessions.id });
  await clearAuthFailures(db, `user:${args.username}`);

  return { reset: true, userId: user.id, username: args.username, sessionsRevoked: revoked.length };
}

export type UserListRow = {
  id: number;
  username: string;
  email: string | null;
  isInstanceAdmin: boolean;
  organizations: { slug: string; role: string }[];
};

// Backs `pitchbox user:list`: the fastest way to answer "who can get into
// this deployment" from a shell, without a database client.
export async function listUsersCli(): Promise<UserListRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      isInstanceAdmin: schema.users.isInstanceAdmin,
      orgSlug: schema.organizations.slug,
      role: schema.memberships.role,
    })
    .from(schema.users)
    .leftJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
    .orderBy(schema.users.username);

  const byId = new Map<number, UserListRow>();
  for (const row of rows) {
    let user = byId.get(row.id);
    if (!user) {
      user = {
        id: row.id,
        username: row.username,
        email: row.email,
        isInstanceAdmin: row.isInstanceAdmin,
        organizations: [],
      };
      byId.set(row.id, user);
    }
    if (row.orgSlug && row.role) {
      user.organizations.push({ slug: row.orgSlug, role: row.role });
    }
  }
  return [...byId.values()];
}

export function registerUserCommands(program: Command) {
  program
    .command('user:create <username>')
    .description(
      `Create an account (and default-org owner membership). ${PASSWORD_HELP} Pass --admin to also grant instance-admin - a separate, explicit flag rather than something a fresh account gets for free.`,
    )
    .option('--admin', 'grant instance-admin on creation', false)
    .action(async (username: string, opts: { admin: boolean }) => {
      const password = await readSecret(PASSWORD_ENV, `Password for ${username}: `);
      const result = await createUserCli({ username, password, admin: opts.admin });
      if (!result.created) fail(result.reason, result);
      ok(result);
    });

  program
    .command('user:reset-password <username>')
    .description(
      `Set a new password for an existing account, revoking every one of its sessions and clearing its login-throttle bucket. ${PASSWORD_HELP}`,
    )
    .action(async (username: string) => {
      const password = await readSecret(PASSWORD_ENV, `New password for ${username}: `);
      const result = await resetPasswordCli({ username, password });
      if (!result.reset) fail(result.reason, result);
      ok(result);
    });

  program
    .command('user:list')
    .description(
      'List every account: id, username, email, instance-admin flag, and org membership/role.',
    )
    .action(async () => {
      ok(await listUsersCli());
    });
}
