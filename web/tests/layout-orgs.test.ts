import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { load } from '../src/routes/+layout.server.js';

type LoadEvent = Parameters<typeof load>[0];
// `load` is typed against the generic `LayoutServerLoad` (see $types), whose
// default OutputData includes `| void` - cast the awaited result to the
// shape the loader actually returns so property access below type-checks.
type LoadResult = {
  authOn: boolean;
  org?: { id: number; slug: string; role: string };
  orgs: { id: number; slug: string; name: string; role: string }[];
};

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedUserWithOrgs(username: string) {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
  const [a] = await db
    .insert(schema.organizations)
    .values({ slug: `${username}-a`, name: 'Org A' })
    .returning();
  const [b] = await db
    .insert(schema.organizations)
    .values({ slug: `${username}-b`, name: 'Org B' })
    .returning();
  await db.insert(schema.memberships).values([
    { organizationId: a.id, userId: u.id, role: 'owner' },
    { organizationId: b.id, userId: u.id, role: 'member' },
  ]);
  return { userId: u.id, orgA: a, orgB: b };
}

function event(locals: unknown): LoadEvent {
  return { locals } as unknown as LoadEvent;
}

describe('root layout loader - org data', () => {
  beforeEach(reset);

  it('returns the active org and every membership when signed in', async () => {
    const { userId, orgA, orgB } = await seedUserWithOrgs('lo1');
    const activeOrg = { id: orgA.id, slug: orgA.slug, role: 'owner' };

    const result = (await load(
      event({ user: { id: userId, username: 'lo1' }, org: activeOrg }),
    )) as LoadResult;

    expect(result.authOn).toBe(process.env.PITCHBOX_AUTH === 'on');
    expect(result.org).toEqual(activeOrg);
    expect(result.orgs.map((o) => o.id).sort((x, y) => x - y)).toEqual(
      [orgA.id, orgB.id].sort((x, y) => x - y),
    );
    expect(result.orgs.find((o) => o.id === orgA.id)?.role).toBe('owner');
    expect(result.orgs.find((o) => o.id === orgB.id)?.role).toBe('member');
  });

  it('returns no active org and an empty membership list when signed out', async () => {
    const result = (await load(event({}))) as LoadResult;

    expect(result.org).toBeUndefined();
    expect(result.orgs).toEqual([]);
  });
});
