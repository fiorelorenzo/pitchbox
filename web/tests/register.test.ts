import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createInvite, findOrgBySlug, listUserOrganizations } from '@pitchbox/shared/orgs';
import { saveRegistrationPolicy } from '@pitchbox/shared/registration-policy';
import {
  assertOrgConcurrencyAdmitted,
  getOrgQuotaFields,
  getOrgQuotaSnapshot,
  ORG_QUOTA_DEFAULTS_FALLBACK,
  SELF_REGISTRATION_QUOTA_DEFAULTS_FALLBACK,
} from '@pitchbox/shared/org-quota';
import { POST as register } from '../src/routes/api/auth/register/+server.js';
import { load as inviteLoad } from '../src/routes/invite/[token]/+page.server.js';
import { type CookieJar, makeCookies, runThroughHandle } from './helpers/handle-harness.js';

const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE auth_failures RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM org_invites`);
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  // Keep `default`: seed:core creates it once for the whole suite and other
  // test files running later in this sequential run rely on it existing.
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // This file's tests below predate #505 and exercise what a token-less
  // registration does once it is allowed (own org, dedup, rate limiting),
  // not the policy gate itself - that gate has its own tests in
  // registration-policy.test.ts. Set 'open' explicitly so they keep
  // covering that rather than tripping the invite-only default.
  await saveRegistrationPolicy(db, 'open');
}

async function seedOrgAdmin(orgSlug: string) {
  const db = getDb();
  const [admin] = await db
    .insert(schema.users)
    .values({ username: `admin-${orgSlug}`, passwordHash: 'x' })
    .returning();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug: orgSlug, name: orgSlug })
    .returning();
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: admin.id, role: 'owner' });
  return { adminId: admin.id, orgId: org.id };
}

function makeEvent(body: unknown, jar: CookieJar, ip = '10.1.0.1'): RequestEvent {
  const request = new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    // #514: the register route now builds the verification link from
    // `event.url.origin`, same convention as /api/auth/password/forgot -
    // this hand-rolled event needs a `url` for that, same as it already
    // needs `request`/`cookies`/`getClientAddress`.
    url: new URL(request.url),
    cookies: makeCookies(jar),
    getClientAddress: () => ip,
  } as unknown as RequestEvent;
}

async function callRegister(body: unknown, jar: CookieJar, ip = '10.1.0.1'): Promise<Response> {
  return await register(makeEvent(body, jar, ip));
}

describe('POST /api/auth/register', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  // Acceptance: the whole point of #504 - an invited person could not
  // reach an account at all before this route existed.
  it('an invited person registers, is signed in, and ends up with the invited membership and no default membership', async () => {
    const { adminId, orgId } = await seedOrgAdmin('acme');
    const invite = await createInvite(getDb(), {
      organizationId: orgId,
      role: 'admin',
      createdByUserId: adminId,
    });
    const orgCountBefore = (
      await getDb().select({ id: schema.organizations.id }).from(schema.organizations)
    ).length;

    const jar: CookieJar = { store: new Map() };
    const res = await callRegister(
      {
        username: 'invitee1',
        email: 'invitee1@example.com',
        password: 'a-very-long-password',
        token: invite.token,
      },
      jar,
    );
    expect(res.status).toBe(200);
    expect(jar.store.get('pitchbox_session')).toBeTruthy();

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'invitee1'));
    expect(user.email).toBe('invitee1@example.com');

    const orgs = await listUserOrganizations(getDb(), user.id);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].slug).toBe('acme');
    expect(orgs[0].role).toBe('admin');

    // #513: an invited registration must get nothing new - joining the
    // inviting org, never a second organization of its own.
    const orgCountAfter = (
      await getDb().select({ id: schema.organizations.id }).from(schema.organizations)
    ).length;
    expect(orgCountAfter).toBe(orgCountBefore);

    const [invRow] = await getDb()
      .select()
      .from(schema.orgInvites)
      .where(eq(schema.orgInvites.token, invite.token));
    expect(invRow.acceptedAt).not.toBeNull();
  });

  it('a second use of an already-consumed invite token is refused and creates no account', async () => {
    const { adminId, orgId } = await seedOrgAdmin('reused');
    const invite = await createInvite(getDb(), { organizationId: orgId, createdByUserId: adminId });

    const jar1: CookieJar = { store: new Map() };
    const first = await callRegister(
      {
        username: 'first-in',
        email: 'first@example.com',
        password: 'a-very-long-password',
        token: invite.token,
      },
      jar1,
    );
    expect(first.status).toBe(200);

    const jar2: CookieJar = { store: new Map() };
    const second = await callRegister(
      {
        username: 'second-in',
        email: 'second@example.com',
        password: 'a-very-long-password',
        token: invite.token,
      },
      jar2,
    );
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.error).toBe('invalid_or_expired_invite');

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'second-in'));
    expect(user).toBeUndefined();
  });

  it('an expired invite token refuses registration and creates no account', async () => {
    const { adminId, orgId } = await seedOrgAdmin('expired-org');
    const invite = await createInvite(getDb(), { organizationId: orgId, createdByUserId: adminId });
    await getDb().execute(
      sql`UPDATE org_invites SET expires_at = now() - interval '1 day' WHERE token = ${invite.token}`,
    );

    const jar: CookieJar = { store: new Map() };
    const res = await callRegister(
      {
        username: 'toolate',
        email: 'toolate@example.com',
        password: 'a-very-long-password',
        token: invite.token,
      },
      jar,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_or_expired_invite');
    expect(jar.store.get('pitchbox_session')).toBeUndefined();

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'toolate'));
    expect(user).toBeUndefined();
  });

  it('a stranger with no invite registers into their own new organization, not default, on the lower self-registration default quota (#540) - distinct from org_quota_defaults', async () => {
    const jar: CookieJar = { store: new Map() };
    const res = await callRegister(
      { username: 'solo-founder', email: 'solo@example.com', password: 'a-very-long-password' },
      jar,
    );
    expect(res.status).toBe(200);

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'solo-founder'));
    const orgs = await listUserOrganizations(getDb(), user.id);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].slug).not.toBe('default');
    expect(orgs[0].role).toBe('owner');

    // #540: a self-registered stranger's org starts on the lower
    // self-registration default, never the shared org_quota_defaults an
    // invited or manually-provisioned org gets (#515 introduced that
    // shared default; #540 split it in two) - and never the unbounded
    // `null` a bare column default would leave it on.
    const fields = await getOrgQuotaFields(getDb(), orgs[0].id);
    expect(fields).toEqual(SELF_REGISTRATION_QUOTA_DEFAULTS_FALLBACK);
    expect(fields).not.toEqual(ORG_QUOTA_DEFAULTS_FALLBACK);
  });

  it("a self-created org's default caps are enforced by the existing concurrency and budget assertions, not a new check", async () => {
    const jar: CookieJar = { store: new Map() };
    const res = await callRegister(
      {
        username: 'quota-check',
        email: 'quota-check@example.com',
        password: 'a-very-long-password',
      },
      jar,
    );
    expect(res.status).toBe(200);

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'quota-check'));
    const orgs = await listUserOrganizations(getDb(), user.id);
    const orgId = orgs[0].id;
    const fields = await getOrgQuotaFields(getDb(), orgId);
    if (!fields || fields.monthlyRunBudgetUsd == null || fields.maxConcurrentRuns == null) {
      throw new Error('org has no quota fields');
    }

    const [project] = await getDb()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, orgId));

    // Fill every concurrency slot the default allows, then one more -
    // assertOrgConcurrencyAdmitted (shared/src/org-quota.ts, the same
    // function the cloud dispatch path calls) has to refuse it.
    let extraRunId = 0;
    for (let i = 0; i < fields.maxConcurrentRuns + 1; i++) {
      const [run] = await getDb()
        .insert(schema.runs)
        .values({
          kind: 'project_extraction',
          projectId: project.id,
          trigger: 'manual',
          status: 'running',
        })
        .returning({ id: schema.runs.id });
      extraRunId = run.id;
    }
    await expect(assertOrgConcurrencyAdmitted(getDb(), orgId, extraRunId)).rejects.toThrow(
      /concurrency limit/i,
    );

    // Spend one dollar past the default monthly budget - getOrgQuotaSnapshot
    // (the same function the cloud dispatch path reads before starting a
    // run) has to report a negative remaining balance, not the unlimited
    // `null` a manually-provisioned org's untouched columns would give.
    await getDb()
      .insert(schema.runs)
      .values({
        kind: 'project_extraction',
        projectId: project.id,
        trigger: 'manual',
        status: 'success',
        costUsd: String(fields.monthlyRunBudgetUsd + 1),
        startedAt: new Date(),
      });
    const snapshot = await getOrgQuotaSnapshot(getDb(), orgId);
    expect(snapshot.remainingUsd).not.toBeNull();
    expect(snapshot.remainingUsd as number).toBeLessThan(0);
  });

  it('two strangers whose usernames collide on the derived slug get distinct organizations', async () => {
    const jar1: CookieJar = { store: new Map() };
    await callRegister(
      { username: 'sameish', email: 'sameish1@example.com', password: 'a-very-long-password' },
      jar1,
    );
    const jar2: CookieJar = { store: new Map() };
    await callRegister(
      { username: 'sameish-2', email: 'sameish2@example.com', password: 'a-very-long-password' },
      jar2,
    );
    // Both derive the same slug base ("sameish") after stripping non-slug
    // characters, so the second must be collision-suffixed rather than fail.
    expect(await findOrgBySlug(getDb(), 'sameish')).not.toBeNull();
    expect(await findOrgBySlug(getDb(), 'sameish-2')).not.toBeNull();
  });

  it('refuses a duplicate email that differs only in case and surrounding whitespace', async () => {
    const jar1: CookieJar = { store: new Map() };
    const first = await callRegister(
      { username: 'dupemail1', email: 'Case@Example.com', password: 'a-very-long-password' },
      jar1,
    );
    expect(first.status).toBe(200);

    const jar2: CookieJar = { store: new Map() };
    const second = await callRegister(
      { username: 'dupemail2', email: '  case@EXAMPLE.com  ', password: 'a-very-long-password' },
      jar2,
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('email_taken');

    const rows = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'dupemail2'));
    expect(rows).toHaveLength(0);
  });

  it('refuses a duplicate username', async () => {
    const jar1: CookieJar = { store: new Map() };
    const first = await callRegister(
      { username: 'dupeuser', email: 'dupeuser1@example.com', password: 'a-very-long-password' },
      jar1,
    );
    expect(first.status).toBe(200);

    const jar2: CookieJar = { store: new Map() };
    const second = await callRegister(
      { username: 'dupeuser', email: 'dupeuser2@example.com', password: 'a-very-long-password' },
      jar2,
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('username_taken');

    const rows = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'dupeuser2@example.com'));
    expect(rows).toHaveLength(0);
  });

  it('rejects a body missing the required email with 400', async () => {
    const jar: CookieJar = { store: new Map() };
    await expect(
      callRegister({ username: 'noemail', password: 'a-very-long-password' }, jar),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('/invite/<token> sends a session-less visitor to /register, not /login (#504)', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  it('the real hooks.server.ts handle() redirects an unauthenticated GET to /register?next=...', async () => {
    const jar: CookieJar = { store: new Map() };
    const req = new Request('http://localhost/invite/some-token', {
      headers: { accept: 'text/html' },
    });
    const res = await runThroughHandle(req, jar, async () => new Response('unreachable'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/register?next=%2Finvite%2Fsome-token');
  });

  it("the invite page's own load() redirects an unauthenticated visitor to /register as a defense-in-depth fallback", async () => {
    const { adminId, orgId } = await seedOrgAdmin('fallback-org');
    const invite = await createInvite(getDb(), { organizationId: orgId, createdByUserId: adminId });
    const event = {
      params: { token: invite.token },
      url: new URL(`http://x/invite/${invite.token}`),
      locals: {},
    } as unknown as Parameters<typeof inviteLoad>[0];
    await expect(inviteLoad(event)).rejects.toMatchObject({
      status: 302,
      location: `/register?next=%2Finvite%2F${invite.token}`,
    });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
});
