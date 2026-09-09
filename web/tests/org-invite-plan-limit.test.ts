import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { PLAN_CATALOGUE } from '@pitchbox/shared/plans';
import { POST as invitesPost } from '../src/routes/api/orgs/[slug]/invites/+server.js';

/**
 * #548: POST /api/orgs/[slug]/invites refuses once the org is at its plan's
 * seat limit - a pending invite consumes a seat immediately, so the limit
 * cannot be bypassed by inviting several people at once.
 */

async function reset() {
  await getDb().execute(sql`DELETE FROM org_invites`);
  await getDb().execute(sql`DELETE FROM memberships`);
  await getDb().execute(sql`DELETE FROM users`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function makeOrgWithAdmin(slug: string, plan: string = 'free') {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, plan })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ username: `${slug}-admin`, passwordHash: 'x' })
    .returning();
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role: 'owner' });
  return { orgId: org.id, userId: user.id, slug: org.slug };
}

async function makePendingInvite(orgId: number) {
  await getDb()
    .insert(schema.orgInvites)
    .values({
      organizationId: orgId,
      token: randomUUID(),
      role: 'member',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
}

function postEvent(userId: number, slug: string, body: unknown): Parameters<typeof invitesPost>[0] {
  return {
    locals: { user: { id: userId } },
    params: { slug },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }),
    url: new URL('http://x/'),
  } as unknown as Parameters<typeof invitesPost>[0];
}

describe('POST /api/orgs/[slug]/invites is plan-limit-gated (#548)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;
  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  const freeLimit = PLAN_CATALOGUE.free.seats!;

  it('refuses once the org is at its plan seat limit (owner already fills it)', async () => {
    const { orgId, userId, slug } = await makeOrgWithAdmin('invite-plan-limit-over');
    // The owner's own membership already counts as 1 seat - the free plan's
    // seat limit is 1, so it is already at the cap with nobody else invited.
    expect(freeLimit).toBe(1);

    const res = await invitesPost(postEvent(userId, slug, { email: 'friend@example.com' }));

    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error?: string;
      metric?: string;
      limit?: number;
      used?: number;
    };
    expect(body.error).toBe('plan_limit_reached');
    expect(body.metric).toBe('seats');
    expect(body.limit).toBe(freeLimit);

    const invites = await getDb()
      .select()
      .from(schema.orgInvites)
      .where(eq(schema.orgInvites.organizationId, orgId));
    expect(invites).toHaveLength(0); // nothing created
  });

  it('a pending invite counts as a seat - a second invite past the limit is refused too', async () => {
    const { orgId, userId, slug } = await makeOrgWithAdmin('invite-plan-limit-pending', 'growth');
    // Growth's seat limit is 3: the owner (1) + two pending invites (2, 3) fills it.
    const growthSeats = PLAN_CATALOGUE.growth.seats!;
    for (let i = 0; i < growthSeats - 1; i += 1) await makePendingInvite(orgId);

    const res = await invitesPost(postEvent(userId, slug, { email: 'onemore@example.com' }));

    expect(res.status).toBe(402);
  });

  it('a self-host install refuses nothing, however many members and invites the org has', async () => {
    delete process.env.PITCHBOX_EDITION;
    const { orgId, userId, slug } = await makeOrgWithAdmin('invite-plan-limit-self-host');
    for (let i = 0; i < 10; i += 1) await makePendingInvite(orgId);

    const res = await invitesPost(postEvent(userId, slug, { email: 'plenty@example.com' }));

    expect(res.status).toBe(201);
  });
});
