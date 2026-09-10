import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import {
  POST as orgPlansPost,
  DELETE as orgPlansDelete,
} from '../src/routes/api/settings/admin/org-plans/+server.js';
import { load as planGrantsLoad } from '../src/routes/settings/admin/plan-grants/+page.server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

// runThroughHandle's routeHandler param is `(event: unknown) => Promise<Response>`;
// the imported route handlers are typed against SvelteKit's own `RequestEvent`,
// so the handoff needs a named unchecked cast rather than the plain `any` the
// older instance-admin-gating.test.ts predates this rule with.
type RouteHandler = (event: unknown) => Promise<Response>;

// #187: the instance-admin plan-grant surface. `setOrgPlan`
// (shared/src/orgs.ts) was already the only writer of `organizations.plan`/
// `plan_source` outside the Stripe webhook; this exercises the second
// caller it anticipated - grant and revoke through
// api/settings/admin/org-plans, gated by requireInstanceAdmin like every
// other write on this rail (settings-admin-gating.test.ts /
// instance-admin-gating.test.ts's own convention).

const PASSWORD = 'correct-horse-battery';
const originalAuth = process.env.PITCHBOX_AUTH;

async function sessionFor(
  username: string,
  role: 'member' | 'admin' | 'owner',
  isInstanceAdmin: boolean,
): Promise<CookieJar> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .onConflictDoUpdate({ target: schema.users.username, set: { isInstanceAdmin } });
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

async function makeGrantOrg(slug: string): Promise<number> {
  const [org] = await getDb()
    .insert(schema.organizations)
    .values({ slug, name: slug, plan: 'scale', planSource: 'grant' })
    .returning();
  return org.id;
}

async function makeGrantOrgWithSubscription(
  slug: string,
  subscriptionPlanId: string,
): Promise<number> {
  const orgId = await makeGrantOrg(slug);
  const customerId = `cus_${randomUUID()}`;
  await getDb()
    .update(schema.organizations)
    .set({ stripeCustomerId: customerId })
    .where(eq(schema.organizations.id, orgId));
  await getDb()
    .insert(schema.orgSubscriptions)
    .values({
      organizationId: orgId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      planId: subscriptionPlanId,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      limitRuns: 500,
      limitSuggestions: 500,
      limitProjects: 3,
      limitSeats: 1,
      limitDevices: 3,
      limitConcurrency: 2,
      limitBudgetUsd: '10.00',
      limitRetentionDays: 30,
      limitPremiumModels: false,
    });
  return orgId;
}

async function orgRow(orgId: number) {
  const [row] = await getDb()
    .select({ plan: schema.organizations.plan, planSource: schema.organizations.planSource })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  return row;
}

function grantReq(body: unknown) {
  return new Request('http://localhost/api/settings/admin/org-plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function revokeReq(body: unknown) {
  return new Request('http://localhost/api/settings/admin/org-plans', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('settings/admin/plan-grants +page.server.ts load', () => {
  it('a signed-in user who is not the instance admin is forbidden (403)', async () => {
    const hash = await hashPassword(PASSWORD);
    await getDb()
      .insert(schema.users)
      .values({ username: 'opg-load-plain', passwordHash: hash, isInstanceAdmin: false })
      .onConflictDoUpdate({ target: schema.users.username, set: { isInstanceAdmin: false } });
    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(sql`username = 'opg-load-plain'`);
    await expect(
      planGrantsLoad({ locals: { user } } as unknown as Parameters<typeof planGrantsLoad>[0]),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('POST /api/settings/admin/org-plans (grant, via real handle)', () => {
  it('an org admin who is not instance-admin is forbidden (403)', async () => {
    const orgId = await makeGrantOrg('opg-grant-refuse');
    const jar = await sessionFor('opg-grant-admin', 'admin', false);
    await expect(
      runThroughHandle(
        grantReq({ orgId, planId: 'growth', reason: 'test' }),
        jar,
        orgPlansPost as unknown as RouteHandler,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('an instance-admin grant sets plan and plan_source=grant', async () => {
    const [freeOrg] = await getDb()
      .insert(schema.organizations)
      .values({ slug: 'opg-grant-target', name: 'opg-grant-target' })
      .returning();
    const jar = await sessionFor('opg-grant-iadmin', 'admin', true);
    const res = await runThroughHandle(
      grantReq({ orgId: freeOrg.id, planId: 'growth', reason: 'friend discount' }),
      jar,
      orgPlansPost as unknown as RouteHandler,
    );
    expect(res.status).toBe(200);
    const row = await orgRow(freeOrg.id);
    expect(row).toMatchObject({ plan: 'growth', planSource: 'grant' });
  });
});

describe('DELETE /api/settings/admin/org-plans (revoke, via real handle)', () => {
  it('an org admin who is not instance-admin is forbidden (403)', async () => {
    const orgId = await makeGrantOrg('opg-revoke-refuse');
    const jar = await sessionFor('opg-revoke-admin', 'admin', false);
    await expect(
      runThroughHandle(revokeReq({ orgId }), jar, orgPlansDelete as unknown as RouteHandler),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('revoking a grant with a mirrored subscription lands on the subscription plan', async () => {
    const orgId = await makeGrantOrgWithSubscription('opg-revoke-sub', 'solo');
    const jar = await sessionFor('opg-revoke-iadmin-sub', 'admin', true);
    const res = await runThroughHandle(
      revokeReq({ orgId }),
      jar,
      orgPlansDelete as unknown as RouteHandler,
    );
    expect(res.status).toBe(200);
    const row = await orgRow(orgId);
    expect(row).toMatchObject({ plan: 'solo', planSource: 'stripe' });
  });

  it('revoking a grant with no mirrored subscription lands on free', async () => {
    const orgId = await makeGrantOrg('opg-revoke-nosub');
    const jar = await sessionFor('opg-revoke-iadmin-nosub', 'admin', true);
    const res = await runThroughHandle(
      revokeReq({ orgId }),
      jar,
      orgPlansDelete as unknown as RouteHandler,
    );
    expect(res.status).toBe(200);
    const row = await orgRow(orgId);
    expect(row).toMatchObject({ plan: 'free', planSource: 'stripe' });
  });

  it('revoking an org that is not on a grant is rejected (400), plan untouched', async () => {
    const [stripeOrg] = await getDb()
      .insert(schema.organizations)
      .values({
        slug: 'opg-revoke-notgrant',
        name: 'opg-revoke-notgrant',
        plan: 'growth',
        planSource: 'stripe',
      })
      .returning();
    const jar = await sessionFor('opg-revoke-iadmin-notgrant', 'admin', true);
    await expect(
      runThroughHandle(
        revokeReq({ orgId: stripeOrg.id }),
        jar,
        orgPlansDelete as unknown as RouteHandler,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const row = await orgRow(stripeOrg.id);
    expect(row).toMatchObject({ plan: 'growth', planSource: 'stripe' });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getDb().execute(sql`DELETE FROM organizations WHERE slug LIKE 'opg-%'`);
  await getPool().end();
});
