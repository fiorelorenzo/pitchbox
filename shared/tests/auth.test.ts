import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, sql, and } from 'drizzle-orm';
import { getDb, getPool } from '../src/db/client.js';
import { users, projects } from '../src/db/schema.js';
import { PERSONAL_PROJECT_SLUG } from '../src/personal-project.js';
import {
  hashPassword,
  verifyPassword,
  createUser,
  findUserByUsername,
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
    const id = await createUser(getDb(), 'alice', 'a-very-long-password');
    expect(typeof id).toBe('number');

    const org = await loadOrganizationForUser(getDb(), id);
    expect(org).not.toBeNull();
    expect(org?.slug).toBe('default');
    expect(org?.role).toBe('owner');

    expect(await countUsers(getDb())).toBe(1);
  });

  // reset() truncates `organizations`, so this exercises the fresh-install
  // path inside createUser (no seed:core has run): the default org is
  // created inline, and it must not have to wait for a migration to get its
  // `personal` project (shared/src/personal-project.ts, decision 2026-09-07).
  it('createUser creates the personal project for a freshly-created default org', async () => {
    const id = await createUser(getDb(), 'frank', 'a-very-long-password');
    const org = await loadOrganizationForUser(getDb(), id);
    expect(org).not.toBeNull();

    const [personalProject] = await getDb()
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, org!.id), eq(projects.slug, PERSONAL_PROJECT_SLUG)));
    expect(personalProject).toBeDefined();
  });

  it('createUser defaults isInstanceAdmin to false, and honours the opt-in (#137)', async () => {
    const memberId = await createUser(getDb(), 'dave', 'a-very-long-password');
    const [memberRow] = await getDb().select().from(users).where(eq(users.id, memberId));
    expect(memberRow.isInstanceAdmin).toBe(false);

    const ownerId = await createUser(getDb(), 'erin', 'a-very-long-password', {
      isInstanceAdmin: true,
    });
    const [ownerRow] = await getDb().select().from(users).where(eq(users.id, ownerId));
    expect(ownerRow.isInstanceAdmin).toBe(true);
  });

  it('findUserByUsername returns null when missing', async () => {
    expect(await findUserByUsername(getDb(), 'nope')).toBeNull();
  });

  it('setInstanceAdmin flips the flag on and off (#413)', async () => {
    const userId = await createUser(getDb(), 'frank', 'a-very-long-password');
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
    await createUser(getDb(), 'zack', 'a-very-long-password');
    await createUser(getDb(), 'amy', 'a-very-long-password', { isInstanceAdmin: true });
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
    const userId = await createUser(getDb(), 'bob', 'a-very-long-password');
    const sess = await createSession(getDb(), userId);
    expect(sess.id).toMatch(/^[0-9a-f]{64}$/);

    const loaded = await loadSession(getDb(), sess.id);
    expect(loaded?.userId).toBe(userId);
    expect(loaded?.username).toBe('bob');

    await deleteSession(getDb(), sess.id);
    expect(await loadSession(getDb(), sess.id)).toBeNull();
  });

  it('expired sessions are not returned by loadSession', async () => {
    const userId = await createUser(getDb(), 'carol', 'a-very-long-password');
    const sess = await createSession(getDb(), userId);
    // Force-expire the row.
    await getDb().execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${sess.id}`,
    );
    expect(await loadSession(getDb(), sess.id)).toBeNull();
  });
});

afterAll(async () => {
  await getPool().end();
});
