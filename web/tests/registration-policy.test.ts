// #505: the registration policy switch. `POST /api/auth/register`'s own
// behavior (self-org creation, dedup, invite acceptance) already has
// coverage in register.test.ts, seeded to the 'open' policy so it keeps
// exercising that rather than this gate. This file is the gate itself: the
// three `app_config.registration_policy` states, the code default with no
// config row at all, and the instance-admin-only write side.
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createInvite } from '@pitchbox/shared/orgs';
import { hashPassword } from '@pitchbox/shared/auth';
import {
  loadRegistrationPolicy,
  saveRegistrationPolicy,
} from '@pitchbox/shared/registration-policy';
import { POST as register } from '../src/routes/api/auth/register/+server.js';
import {
  GET as adminGet,
  POST as adminPost,
} from '../src/routes/api/settings/admin/registration/+server.js';
import { type CookieJar, makeCookies } from './helpers/handle-harness.js';

const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE auth_failures RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM org_invites`);
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // No row at all, not even an explicit 'invite' - this is what a fresh
  // install actually has, and loadRegistrationPolicy must fall back to the
  // 'invite' code default rather than erroring or defaulting open.
  await db.execute(sql`DELETE FROM app_config WHERE key = 'registration_policy'`);
  await db.execute(sql`DELETE FROM instance_audit_log`);
}

async function seedOrgOwner(orgSlug: string) {
  const db = getDb();
  const [owner] = await db
    .insert(schema.users)
    .values({ username: `owner-${orgSlug}`, passwordHash: 'x' })
    .returning();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug: orgSlug, name: orgSlug })
    .returning();
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: owner.id, role: 'owner' });
  return { ownerId: owner.id, orgId: org.id };
}

function registerEvent(body: unknown, jar: CookieJar): RequestEvent {
  const url = 'http://localhost/api/auth/register';
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    // The route builds the verification link from the request's own origin
    // (#514, web/src/lib/trusted-origins.js), so a synthetic event without a
    // url makes it throw rather than answer - which is a fixture gap, not a
    // route defect. Same reasoning for `locals.locale` (LOR-264): production
    // always has it by the time a route handler runs (hooks.server.ts,
    // LOR-260), so the registration_closed/invite_required message lookup
    // reads it directly rather than guarding against a shape that can't
    // occur outside a fixture.
    url: new URL(url),
    cookies: makeCookies(jar),
    getClientAddress: () => '10.2.0.1',
    locals: { locale: 'en' },
  } as unknown as RequestEvent;
}

async function callRegister(body: unknown): Promise<Response> {
  return await register(registerEvent(body, { store: new Map() }));
}

// requireInstanceAdmin only ever looks at event.locals.user and re-queries
// users.is_instance_admin - it does not consult locals.org, so a synthetic
// event with just `locals.user` exercises the real gate, same convention as
// retention-role.test.ts.
async function userWith(username: string, isInstanceAdmin: boolean): Promise<{ id: number }> {
  const hash = await hashPassword('correct-horse-battery');
  const [user] = await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .returning({ id: schema.users.id });
  return user;
}

function adminEvent(user: { id: number } | undefined, body?: unknown): RequestEvent {
  return {
    locals: user ? { user } : {},
    request: new Request('http://localhost/api/settings/admin/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as unknown as RequestEvent;
}

describe('registration policy (#505)', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  // The assertion that matters most: with no configuration at all, a
  // token-less registration is refused, and refused with its own error code
  // (not invalid_credentials, not a bare 403) so the page can explain why.
  it('with no configuration at all, a token-less registration is refused - the default is closed', async () => {
    expect(await loadRegistrationPolicy(getDb())).toBe('invite');

    const res = await callRegister({
      username: 'nobody',
      email: 'nobody@example.com',
      password: 'a-very-long-password',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invite_required');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(sql`username = 'nobody'`);
    expect(user).toBeUndefined();
  });

  it('a valid invite token still registers under the closed default', async () => {
    const { ownerId, orgId } = await seedOrgOwner('closed-invite');
    const invite = await createInvite(getDb(), { organizationId: orgId, createdByUserId: ownerId });

    const res = await callRegister({
      username: 'invited-under-closed',
      email: 'invited-under-closed@example.com',
      password: 'a-very-long-password',
      token: invite.token,
    });
    expect(res.status).toBe(200);

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(sql`username = 'invited-under-closed'`);
    expect(user).toBeDefined();
  });

  it("'off' refuses registration outright, with or without a token", async () => {
    const { ownerId, orgId } = await seedOrgOwner('off-org');
    const invite = await createInvite(getDb(), { organizationId: orgId, createdByUserId: ownerId });
    await saveRegistrationPolicy(getDb(), 'off');

    const withoutToken = await callRegister({
      username: 'off-stranger',
      email: 'off-stranger@example.com',
      password: 'a-very-long-password',
    });
    expect(withoutToken.status).toBe(403);
    expect((await withoutToken.json()).error).toBe('registration_closed');

    const withToken = await callRegister({
      username: 'off-invited',
      email: 'off-invited@example.com',
      password: 'a-very-long-password',
      token: invite.token,
    });
    expect(withToken.status).toBe(403);
    expect((await withToken.json()).error).toBe('registration_closed');

    const rows = await getDb()
      .select()
      .from(schema.users)
      .where(sql`username in ('off-stranger', 'off-invited')`);
    expect(rows).toHaveLength(0);
  });

  it('an instance admin can open registration, and a token-less registration then succeeds', async () => {
    const admin = await userWith('reg-policy-iadmin', true);
    const res = await adminPost(adminEvent(admin, { policy: 'open' }));
    expect(res.status).toBe(200);
    expect(await loadRegistrationPolicy(getDb())).toBe('open');

    const registered = await callRegister({
      username: 'opened-up',
      email: 'opened-up@example.com',
      password: 'a-very-long-password',
    });
    expect(registered.status).toBe(200);

    // Recorded on the instance-wide audit trail, not silently.
    const [auditRow] = await getDb()
      .select()
      .from(schema.instanceAuditLog)
      .where(sql`key = 'registration_policy'`);
    expect(auditRow).toBeDefined();
  });

  it('a member cannot flip the switch', async () => {
    const member = await userWith('reg-policy-member', false);
    await expect(adminPost(adminEvent(member, { policy: 'open' }))).rejects.toMatchObject({
      status: 403,
    });
    expect(await loadRegistrationPolicy(getDb())).toBe('invite');
  });

  it('an org owner who is not the instance admin cannot flip the switch', async () => {
    const { ownerId } = await seedOrgOwner('owner-cannot-flip');
    await expect(adminPost(adminEvent({ id: ownerId }, { policy: 'open' }))).rejects.toMatchObject({
      status: 403,
    });
    expect(await loadRegistrationPolicy(getDb())).toBe('invite');
  });

  it('the GET side is instance-admin gated too', async () => {
    const member = await userWith('reg-policy-get-member', false);
    await expect(adminGet(adminEvent(member))).rejects.toMatchObject({ status: 403 });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
});
