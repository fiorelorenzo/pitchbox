import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE projects RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

describe('project org constraints', () => {
  beforeEach(reset);

  it('allows the same project slug in two different orgs', async () => {
    const db = getDb();
    const [a] = await db
      .insert(schema.organizations)
      .values({ slug: 'sc-a', name: 'A' })
      .returning();
    const [b] = await db
      .insert(schema.organizations)
      .values({ slug: 'sc-b', name: 'B' })
      .returning();
    await db.insert(schema.projects).values({ organizationId: a.id, slug: 'dup', name: 'dup A' });
    await expect(
      db.insert(schema.projects).values({ organizationId: b.id, slug: 'dup', name: 'dup B' }),
    ).resolves.toBeDefined();
  });

  it('rejects a duplicate project slug within the same org', async () => {
    const db = getDb();
    const [a] = await db
      .insert(schema.organizations)
      .values({ slug: 'sc-c', name: 'C' })
      .returning();
    await db.insert(schema.projects).values({ organizationId: a.id, slug: 'same', name: 'one' });
    await expect(
      db.insert(schema.projects).values({ organizationId: a.id, slug: 'same', name: 'two' }),
    ).rejects.toThrow();
  });

  it('rejects a project with no organization', async () => {
    const db = getDb();
    await expect(
      // Cast: after NOT NULL the TS type requires organizationId; this is the negative case.
      db.insert(schema.projects).values({ slug: 'orphan', name: 'orphan' } as never),
    ).rejects.toThrow();
  });
});
