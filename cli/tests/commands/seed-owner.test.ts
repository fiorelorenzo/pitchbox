import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { sql } from 'drizzle-orm';

function cli(args: string, env?: Record<string, string>): string {
  return execSync(`pnpm -s -F @pitchbox/cli dev ${args}`, {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
}

function lastJson(out: string) {
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE users, sessions, memberships, organizations RESTART IDENTITY CASCADE`,
  );
}

describe('pitchbox seed:owner', () => {
  beforeEach(reset);

  it('creates the owner user and default-org owner membership on an empty users table (issue #109)', async () => {
    const out = cli('seed:owner', {
      PITCHBOX_OWNER_USERNAME: 'admin',
      PITCHBOX_OWNER_PASSWORD: 'a-very-long-password',
    });
    const res = lastJson(out);
    expect(res.ok).toBe(true);
    expect(res.data.created).toBe(true);
    expect(res.data.username).toBe('admin');
    expect(typeof res.data.userId).toBe('number');

    const db = getDb();
    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('admin');

    const org = await db
      .select({ role: schema.memberships.role, orgSlug: schema.organizations.slug })
      .from(schema.memberships)
      .innerJoin(
        schema.organizations,
        sql`${schema.organizations.id} = ${schema.memberships.organizationId}`,
      )
      .where(sql`${schema.memberships.userId} = ${users[0].id}`);
    expect(org).toHaveLength(1);
    expect(org[0].role).toBe('owner');
    expect(org[0].orgSlug).toBe('default');
  });

  it('is a no-op when a user already exists', async () => {
    cli('seed:owner', {
      PITCHBOX_OWNER_USERNAME: 'admin',
      PITCHBOX_OWNER_PASSWORD: 'a-very-long-password',
    });

    const out = cli('seed:owner', {
      PITCHBOX_OWNER_USERNAME: 'someone-else',
      PITCHBOX_OWNER_PASSWORD: 'another-long-password',
    });
    const res = lastJson(out);
    expect(res.ok).toBe(true);
    expect(res.data.created).toBe(false);
    expect(res.data.reason).toBe('user_exists');

    const db = getDb();
    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('admin');
  });

  it('is a no-op when the owner env vars are unset', async () => {
    const out = cli('seed:owner', {
      PITCHBOX_OWNER_USERNAME: '',
      PITCHBOX_OWNER_PASSWORD: '',
    });
    const res = lastJson(out);
    expect(res.ok).toBe(true);
    expect(res.data.created).toBe(false);
    expect(res.data.reason).toBe('env_missing');

    const db = getDb();
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });
});

afterAll(async () => {
  await getPool().end();
});
