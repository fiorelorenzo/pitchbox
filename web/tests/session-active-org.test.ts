import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession, loadSession, setSessionActiveOrg } from '@pitchbox/shared/auth';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

describe('session active org', () => {
  beforeEach(reset);

  it('starts with a null active org and stores a chosen one', async () => {
    const db = getDb();
    const [u] = await db
      .insert(schema.users)
      .values({ username: 'sa', passwordHash: 'x' })
      .returning();
    const [o] = await db
      .insert(schema.organizations)
      .values({ slug: 'sa-o', name: 'O' })
      .returning();
    const s = await createSession(db, u.id);

    const before = await loadSession(db, s.id);
    expect(before?.activeOrganizationId).toBeNull();

    await setSessionActiveOrg(db, s.id, o.id);
    const after = await loadSession(db, s.id);
    expect(after?.activeOrganizationId).toBe(o.id);
    expect(after?.username).toBe('sa');
  });
});
