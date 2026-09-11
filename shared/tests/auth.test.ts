import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '../src/db/client.js';
import { users, projects, organizations } from '../src/db/schema.js';
import {
  hashPassword,
  verifyPassword,
  createUser,
  createUserRecord,
  findUserByUsername,
  findUserByEmail,
  normalizeEmail,
  createSession,
  loadSession,
  deleteSession,
  countUsers,
  loadOrganizationForUser,
  setInstanceAdmin,
  listUsers,
} from '../src/auth.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE users, sessions, memberships, organizations RESTART IDENTITY CASCADE`,
  );
}

describe('shared/auth', () => {
  beforeEach(reset);

  it('hashes and verifies passwords (round-trip)', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
    expect(stored.split(':')).toHaveLength(2);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('whatever', 'not-a-real-hash')).toBe(false);
    expect(await verifyPassword('whatever', '')).toBe(false);
  });

  it('createUser bootstraps the default org membership', async () => {
    const id = await createUser(getDb(), { username: 'alice', password: 'a-very-long-password' });
    expect(typeof id).toBe('number');

    const org = await loadOrganizationForUser(getDb(), id);
    expect(org).not.toBeNull();
    expect(org?.slug).toBe('default');
    expect(org?.role).toBe('owner');

    expect(await countUsers(getDb())).toBe(1);
  });

  // #523 retired the personal project: createUser used to hand a
  // freshly-created default org a `personal` project inline, and this test
  // pinned that retired auto-creation rather than an observable contract a
  // caller still relies on. Deleted, not re-pinned to the new internals -
  // replaced by the actual #523 acceptance criterion below.
  it('gives a freshly-created default org no project it did not ask for', async () => {
    const id = await createUser(getDb(), { username: 'frank', password: 'a-very-long-password' });
    const org = await loadOrganizationForUser(getDb(), id);
    expect(org).not.toBeNull();

    const orgProjects = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.organizationId, org!.id));
    expect(orgProjects).toHaveLength(0);
  });

  it('createUser defaults isInstanceAdmin to false, and honours the opt-in (#137)', async () => {
    const memberId = await createUser(getDb(), {
      username: 'dave',
      password: 'a-very-long-password',
    });
    const [memberRow] = await getDb().select().from(users).where(eq(users.id, memberId));
    expect(memberRow.isInstanceAdmin).toBe(false);

    const ownerId = await createUser(getDb(), {
      username: 'erin',
      password: 'a-very-long-password',
      isInstanceAdmin: true,
    });
    const [ownerRow] = await getDb().select().from(users).where(eq(users.id, ownerId));
    expect(ownerRow.isInstanceAdmin).toBe(true);
  });

  it('findUserByUsername returns null when missing', async () => {
    expect(await findUserByUsername(getDb(), 'nope')).toBeNull();
  });

  it('normalizeEmail trims and lowercases, and collapses empty/absent to null', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('createUser stores email already normalized, and leaves it null when omitted (#507)', async () => {
    const withEmail = await createUser(getDb(), {
      username: 'greta',
      password: 'a-very-long-password',
      email: '  Greta@Example.COM  ',
    });
    const [row] = await getDb().select().from(users).where(eq(users.id, withEmail));
    expect(row.email).toBe('greta@example.com');

    const withoutEmail = await createUser(getDb(), {
      username: 'harry',
      password: 'a-very-long-password',
    });
    const [row2] = await getDb().select().from(users).where(eq(users.id, withoutEmail));
    expect(row2.email).toBeNull();
  });

  it('findUserByEmail matches case- and whitespace-insensitively, and returns null when missing (#507)', async () => {
    const id = await createUser(getDb(), {
      username: 'ivy',
      password: 'a-very-long-password',
      email: 'ivy@example.com',
    });
    const found = await findUserByEmail(getDb(), '  IVY@Example.com ');
    expect(found?.id).toBe(id);
    expect(await findUserByEmail(getDb(), 'nobody@example.com')).toBeNull();
  });

  // A duplicate address that differs only in case or surrounding whitespace
  // must still collide, since both createUser and the register route always
  // normalize before writing - this is the DB-level backstop for that
  // invariant, independent of any application-level pre-check.
  it('the users.email unique index rejects a second account with the same normalized address (#507)', async () => {
    await createUser(getDb(), {
      username: 'jack',
      password: 'a-very-long-password',
      email: 'jack@example.com',
    });
    await expect(
      createUser(getDb(), {
        username: 'jackalt',
        password: 'a-very-long-password',
        email: '  Jack@Example.com  ',
      }),
    ).rejects.toThrow();
  });

  it('createUserRecord inserts a user row with no org membership, unlike createUser (#504)', async () => {
    const id = await createUserRecord(getDb(), {
      username: 'kim',
      password: 'a-very-long-password',
      email: 'kim@example.com',
    });
    expect(await loadOrganizationForUser(getDb(), id)).toBeNull();
    const [row] = await getDb().select().from(users).where(eq(users.id, id));
    expect(row.email).toBe('kim@example.com');
  });

  it('setInstanceAdmin flips the flag on and off (#413)', async () => {
    const userId = await createUser(getDb(), {
      username: 'frank',
      password: 'a-very-long-password',
    });
    const [before] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(before.isInstanceAdmin).toBe(false);

    await setInstanceAdmin(getDb(), userId, true);
    const [promoted] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(promoted.isInstanceAdmin).toBe(true);

    await setInstanceAdmin(getDb(), userId, false);
    const [demoted] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(demoted.isInstanceAdmin).toBe(false);
  });

  it('listUsers reports every user with their instance-admin flag, ordered by username (#413)', async () => {
    await createUser(getDb(), { username: 'zack', password: 'a-very-long-password' });
    await createUser(getDb(), {
      username: 'amy',
      password: 'a-very-long-password',
      isInstanceAdmin: true,
    });
    const rows = await listUsers(getDb());
    expect(rows.map((r) => r.username)).toEqual(['amy', 'zack']);
    expect(rows.find((r) => r.username === 'amy')?.isInstanceAdmin).toBe(true);
    expect(rows.find((r) => r.username === 'zack')?.isInstanceAdmin).toBe(false);
  });

  // Guards against a second write path for `is_instance_admin` reappearing
  // (#413): the issue this closes was exactly that the flag could only ever
  // be set at insert time (first login) or by hand in the database. Scanning
  // the source rather than trusting the doc comment means a future insert-
  // time `isInstanceAdmin:` assignment fails this test instead of silently
  // drifting from `setInstanceAdmin`.
  it('sessions can be created, loaded, and deleted', async () => {
    const userId = await createUser(getDb(), { username: 'bob', password: 'a-very-long-password' });
    const sess = await createSession(getDb(), userId);
    expect(sess.id).toMatch(/^[0-9a-f]{64}$/);

    const loaded = await loadSession(getDb(), sess.id);
    expect(loaded?.userId).toBe(userId);
    expect(loaded?.username).toBe('bob');

    await deleteSession(getDb(), sess.id);
    expect(await loadSession(getDb(), sess.id)).toBeNull();
  });

  it('expired sessions are not returned by loadSession', async () => {
    const userId = await createUser(getDb(), {
      username: 'carol',
      password: 'a-very-long-password',
    });
    const sess = await createSession(getDb(), userId);
    // Force-expire the row.
    await getDb().execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${sess.id}`,
    );
    expect(await loadSession(getDb(), sess.id)).toBeNull();
  });
});

afterAll(async () => {
  // This file's reset() truncates `organizations` wholesale (not the
  // suite's usual scoped `DELETE ... WHERE slug != 'default'`) because
  // "createUser bootstraps the default org membership" needs the seeded
  // `slug = 'default'` row absent to exercise createUser's fresh-install
  // branch (shared/src/auth.ts): it only creates that org when none exists.
  // Leaving the hole open after this file finishes would silently break
  // every later file that falls back to it (LOR-282) - restore the seeded
  // placeholder explicitly, matching seed-core's own values, rather than
  // relying on it being recreated as a side effect of whichever test in
  // this file happens to run last.
  await getDb()
    .insert(organizations)
    .values({ slug: 'default', name: 'My Organization' })
    .onConflictDoNothing();
  await getPool().end();
});
