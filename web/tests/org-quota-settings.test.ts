import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { getOrgQuotaFields } from '@pitchbox/shared/org-quota';
import { GET, PUT } from '../src/routes/api/settings/org-quota/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

// GET/PUT /api/settings/org-quota back the org-quota settings UI (#161): an
// operator sets `organizations.monthly_run_budget_usd` and
// `max_concurrent_runs` from the dashboard instead of raw SQL. Both routes
// are org-scoped (requireOrgId) and role-gated the same as the Organization
// settings section's admin-only mutations (requireRole(event, 'admin')), per
// docs/permissions.md.

const PASSWORD = 'correct-horse-battery';

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrg(
  slug: string,
  opts: { monthlyRunBudgetUsd?: string | null; maxConcurrentRuns?: number | null } = {},
) {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({
      slug,
      name: slug,
      monthlyRunBudgetUsd: opts.monthlyRunBudgetUsd ?? null,
      maxConcurrentRuns: opts.maxConcurrentRuns ?? null,
    })
    .returning();
  return {
    orgId: org.id,
    slug,
    async member(username: string, role: string) {
      const [u] = await db.insert(schema.users).values({ username, passwordHash: 'x' }).returning();
      await db.insert(schema.memberships).values({ organizationId: org.id, userId: u.id, role });
      return u.id;
    },
  };
}

function ev(orgId: number, role: string, method: 'GET' | 'PUT', body?: unknown): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    request: new Request('http://x/', {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  } as unknown as RequestEvent;
}

async function statusOf(fn: () => Promise<Response>): Promise<number> {
  try {
    return (await fn()).status;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

describe('GET /api/settings/org-quota', () => {
  beforeEach(reset);

  it("returns the org's current values + month-to-date cost", async () => {
    const o = await seedOrg('gq-a', { monthlyRunBudgetUsd: '100.00', maxConcurrentRuns: 3 });
    const res = await GET(ev(o.orgId, 'admin', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      monthlyRunBudgetUsd: 100,
      maxConcurrentRuns: 3,
      monthToDateCostUsd: 0,
      remainingUsd: 100,
    });
  });

  it('returns null budget/cap (unlimited) when unset', async () => {
    const o = await seedOrg('gq-b');
    const res = await GET(ev(o.orgId, 'admin', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.monthlyRunBudgetUsd).toBeNull();
    expect(body.maxConcurrentRuns).toBeNull();
    expect(body.remainingUsd).toBeNull();
  });

  it('a member is forbidden (403)', async () => {
    const o = await seedOrg('gq-c');
    expect(await statusOf(() => GET(ev(o.orgId, 'member', 'GET')))).toBe(403);
  });
});

describe('PUT /api/settings/org-quota', () => {
  beforeEach(reset);

  it('sets budget + cap and they persist (round-trip)', async () => {
    const o = await seedOrg('pq-a');
    const res = await PUT(
      ev(o.orgId, 'admin', 'PUT', { monthlyRunBudgetUsd: 42.5, maxConcurrentRuns: 5 }),
    );
    expect(res.status).toBe(200);
    expect(await getOrgQuotaFields(getDb(), o.orgId)).toEqual({
      monthlyRunBudgetUsd: 42.5,
      maxConcurrentRuns: 5,
    });
  });

  it('blank/null means unlimited', async () => {
    const o = await seedOrg('pq-b', { monthlyRunBudgetUsd: '10.00', maxConcurrentRuns: 2 });
    const res = await PUT(
      ev(o.orgId, 'admin', 'PUT', { monthlyRunBudgetUsd: null, maxConcurrentRuns: null }),
    );
    expect(res.status).toBe(200);
    expect(await getOrgQuotaFields(getDb(), o.orgId)).toEqual({
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
  });

  it('rejects a negative budget', async () => {
    const o = await seedOrg('pq-c');
    const status = await statusOf(() =>
      PUT(ev(o.orgId, 'admin', 'PUT', { monthlyRunBudgetUsd: -1, maxConcurrentRuns: null })),
    );
    expect(status).toBe(400);
    expect(await getOrgQuotaFields(getDb(), o.orgId)).toEqual({
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
  });

  it('rejects a negative concurrency cap', async () => {
    const o = await seedOrg('pq-d');
    const status = await statusOf(() =>
      PUT(ev(o.orgId, 'admin', 'PUT', { monthlyRunBudgetUsd: null, maxConcurrentRuns: -3 })),
    );
    expect(status).toBe(400);
    expect(await getOrgQuotaFields(getDb(), o.orgId)).toEqual({
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
  });

  it('a member is forbidden (403)', async () => {
    const o = await seedOrg('pq-e');
    const status = await statusOf(() =>
      PUT(ev(o.orgId, 'member', 'PUT', { monthlyRunBudgetUsd: 10, maxConcurrentRuns: 1 })),
    );
    expect(status).toBe(403);
    expect(await getOrgQuotaFields(getDb(), o.orgId)).toEqual({
      monthlyRunBudgetUsd: null,
      maxConcurrentRuns: null,
    });
  });

  it("cannot edit another org's row (cross-org isolation)", async () => {
    const a = await seedOrg('pq-iso-a', { monthlyRunBudgetUsd: '10.00', maxConcurrentRuns: 1 });
    const b = await seedOrg('pq-iso-b', { monthlyRunBudgetUsd: '20.00', maxConcurrentRuns: 2 });
    // An admin of org A can only ever act on org A - requireOrgId resolves
    // the orgId from the caller's own locals.org, never from a body/param, so
    // there is no request shape that lets org A's admin touch org B's row.
    const res = await PUT(
      ev(a.orgId, 'admin', 'PUT', { monthlyRunBudgetUsd: 999, maxConcurrentRuns: 99 }),
    );
    expect(res.status).toBe(200);
    expect(await getOrgQuotaFields(getDb(), b.orgId)).toEqual({
      monthlyRunBudgetUsd: 20,
      maxConcurrentRuns: 2,
    });
  });
});

// The role gate is exactly the kind of bug ISO-1 (#132) hid: a hand-injected
// locals.org (as above) can't catch a hooks.server.ts wiring mistake, because
// the hook never runs. Drive these through the real handle() hook instead
// (see helpers/handle-harness.ts).
describe('role gate (real handle() path)', () => {
  async function sessionFor(username: string, role: 'member' | 'admin'): Promise<CookieJar> {
    const hash = await hashPassword(PASSWORD);
    await getDb()
      .insert(schema.users)
      .values({ username, passwordHash: hash })
      .onConflictDoNothing();
    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(sql`username = ${username}`);
    let [org] = await getDb()
      .select()
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    if (!org) {
      [org] = await getDb()
        .insert(schema.organizations)
        .values({ slug: 'default', name: 'Default' })
        .returning();
    }
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: org.id, userId: user.id, role })
      .onConflictDoUpdate({
        target: [schema.memberships.organizationId, schema.memberships.userId],
        set: { role },
      });
    const session = await createSession(getDb(), user.id);
    return { store: new Map([['pitchbox_session', { value: session.id }]]) };
  }

  it('a member session is forbidden (403)', async () => {
    const jar = await sessionFor('orgquota-member', 'member');
    const req = new Request('http://localhost/api/settings/org-quota');
    await expect(runThroughHandle(req, jar, GET as any)).rejects.toMatchObject({ status: 403 });
  });

  it('an admin session can read the quota (200)', async () => {
    const jar = await sessionFor('orgquota-admin', 'admin');
    const req = new Request('http://localhost/api/settings/org-quota');
    const res = await runThroughHandle(req, jar, GET as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect('monthlyRunBudgetUsd' in body).toBe(true);
  });
});

afterAll(async () => {
  await getPool().end();
});
