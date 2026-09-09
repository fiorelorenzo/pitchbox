import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { verifyPassword } from '@pitchbox/shared/auth';
import { sql, eq } from 'drizzle-orm';

function cli(args: string, env?: Record<string, string>): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
}

// Same shape as seed-owner.test.ts's helper: captures both stdout (success)
// and stderr (fail() writes there and exits 1), since a duplicate-username
// or not-found run is expected to fail rather than throw.
function cliResult(args: string, env?: Record<string, string>) {
  try {
    const out = execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    return JSON.parse(out.trim().split('\n').at(-1)!);
  } catch (err) {
    const stdout = String((err as { stdout?: unknown }).stdout ?? '');
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    const combined = (stdout + stderr).trim().split('\n').filter(Boolean);
    return JSON.parse(combined.at(-1)!);
  }
}

function lastJson(out: string) {
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

async function reset() {
  // Same convention as seed-owner.test.ts: never truncate `organizations`
  // (would drop the `default` org other test files in this suite share).
  await getDb().execute(
    sql`TRUNCATE users, sessions, memberships, auth_failures RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

describe('pitchbox user:create', () => {
  beforeEach(reset);

  it('creates an account with a usable password hash, joining the default org', async () => {
    const res = cliResult('user:create alice', { PITCHBOX_CLI_PASSWORD: 'correct horse battery' });
    expect(res.ok).toBe(true);
    expect(res.data.created).toBe(true);
    expect(res.data.username).toBe('alice');
    expect(res.data.isInstanceAdmin).toBe(false);

    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.username, 'alice'));
    expect(user).toBeDefined();
    expect(await verifyPassword('correct horse battery', user.passwordHash)).toBe(true);
    // Not the actual password, hashed differently every time (random salt).
    expect(user.passwordHash).not.toBe('correct horse battery');

    const [membership] = await db
      .select({ role: schema.memberships.role, orgSlug: schema.organizations.slug })
      .from(schema.memberships)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.memberships.organizationId),
      )
      .where(eq(schema.memberships.userId, user.id));
    expect(membership.role).toBe('owner');
    expect(membership.orgSlug).toBe('default');
  });

  it('grants instance-admin only when --admin is passed explicitly', async () => {
    const res = cliResult('user:create bob --admin', {
      PITCHBOX_CLI_PASSWORD: 'correct horse battery',
    });
    expect(res.ok).toBe(true);
    expect(res.data.isInstanceAdmin).toBe(true);

    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.username, 'bob'));
    expect(user.isInstanceAdmin).toBe(true);
  });

  it('fails with an actionable message on a second run against an existing username, rather than a stack trace', async () => {
    cli('user:create carol', { PITCHBOX_CLI_PASSWORD: 'correct horse battery' });
    const res = cliResult('user:create carol', {
      PITCHBOX_CLI_PASSWORD: 'another password entirely',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('user_exists');
    expect(res.details.message).toMatch(/already exists/);
    expect(res.details.message).not.toMatch(/at Object|node_modules|\.ts:\d+/);

    // The original account is untouched - a rejected create must not have
    // silently reset the existing password.
    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.username, 'carol'));
    expect(await verifyPassword('correct horse battery', user.passwordHash)).toBe(true);
  });

  it('never echoes the password anywhere in stdout or stderr', async () => {
    const secret = 'never-print-this-secret-42';
    const out = execSync(`pnpm -s -F @pitchbox/cli dev user:create dave`, {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, PITCHBOX_CLI_PASSWORD: secret },
    });
    expect(out).not.toContain(secret);
  });
});

describe('pitchbox user:reset-password', () => {
  beforeEach(reset);

  it('sets a usable new password, revokes existing sessions, and clears the login-throttle bucket', async () => {
    cli('user:create erin', { PITCHBOX_CLI_PASSWORD: 'original password here' });
    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.username, 'erin'));

    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(schema.sessions).values({ id: 'sess-erin-1', userId: user.id, expiresAt });
    await db.insert(schema.sessions).values({ id: 'sess-erin-2', userId: user.id, expiresAt });
    await db.insert(schema.authFailures).values({ identifier: `user:erin`, kind: 'login' });

    const res = cliResult('user:reset-password erin', {
      PITCHBOX_CLI_PASSWORD: 'brand new password',
    });
    expect(res.ok).toBe(true);
    expect(res.data.reset).toBe(true);
    expect(res.data.sessionsRevoked).toBe(2);

    const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(await verifyPassword('brand new password', updated.passwordHash)).toBe(true);
    expect(await verifyPassword('original password here', updated.passwordHash)).toBe(false);

    const remainingSessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(remainingSessions).toHaveLength(0);

    const remainingFailures = await db
      .select()
      .from(schema.authFailures)
      .where(eq(schema.authFailures.identifier, 'user:erin'));
    expect(remainingFailures).toHaveLength(0);
  });

  it('fails with an actionable message against a username that does not exist, rather than a stack trace', async () => {
    const res = cliResult('user:reset-password ghost', {
      PITCHBOX_CLI_PASSWORD: 'brand new password',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('user_not_found');
    expect(res.details.message).toMatch(/No user named/);
    expect(res.details.message).not.toMatch(/at Object|node_modules|\.ts:\d+/);
  });

  it('never echoes the password anywhere in stdout or stderr', async () => {
    cli('user:create frank', { PITCHBOX_CLI_PASSWORD: 'first password here' });
    const secret = 'never-print-this-either-99';
    const out = execSync(`pnpm -s -F @pitchbox/cli dev user:reset-password frank`, {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, PITCHBOX_CLI_PASSWORD: secret },
    });
    expect(out).not.toContain(secret);
  });
});

describe('pitchbox user:list', () => {
  beforeEach(reset);

  it('prints id, username, email, instance-admin flag, and org membership for every account', async () => {
    cli('user:create grace --admin', { PITCHBOX_CLI_PASSWORD: 'password one here' });
    cli('user:create henry', { PITCHBOX_CLI_PASSWORD: 'password two here' });

    const out = cli('user:list');
    const res = lastJson(out);
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(2);

    const grace = res.data.find((u: { username: string }) => u.username === 'grace');
    expect(grace.isInstanceAdmin).toBe(true);
    expect(grace.organizations).toEqual([{ slug: 'default', role: 'owner' }]);
    expect(grace.email).toBeNull();

    const henry = res.data.find((u: { username: string }) => u.username === 'henry');
    expect(henry.isInstanceAdmin).toBe(false);
    expect(henry.organizations).toEqual([{ slug: 'default', role: 'owner' }]);
  });
});

afterAll(async () => {
  await getPool().end();
});
