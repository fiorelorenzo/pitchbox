import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../src/db/client.js';
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

  it('findUserByUsername returns null when missing', async () => {
    expect(await findUserByUsername(getDb(), 'nope')).toBeNull();
  });

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
