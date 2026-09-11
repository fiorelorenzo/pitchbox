import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { createSession, hashPassword } from '@pitchbox/shared/auth';
import { createInvite } from '@pitchbox/shared/orgs';
import { saveRegistrationPolicy } from '@pitchbox/shared/registration-policy';
import { POST as registerPost } from '../src/routes/api/auth/register/+server.js';
import { POST as verifyConfirm } from '../src/routes/api/auth/verify/confirm/+server.js';
import { POST as verifyResend } from '../src/routes/api/auth/verify/resend/+server.js';
import { POST as runPost } from '../src/routes/api/run/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  const db = getDb();
  await db.execute(sql`TRUNCATE email_verification_tokens RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE auth_failures RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM org_invites`);
  await db.execute(sql`DELETE FROM sessions`);
  await db.execute(sql`DELETE FROM memberships`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`DELETE FROM app_config WHERE key = 'auth_policy'`);
  await db.execute(sql`DELETE FROM campaigns`);
  await db.execute(sql`DELETE FROM projects`);
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  // These tests register without an invite token, which only #505's 'open'
  // policy allows - the code default is 'invite'. Same reasoning as
  // register.test.ts's own reset().
  await saveRegistrationPolicy(db, 'open');
}

async function seedOrgUser(args: {
  username: string;
  email: string | null;
  verified?: boolean;
}): Promise<{ userId: number; orgId: number }> {
  const db = getDb();
  const hash = await hashPassword('correct-horse-battery');
  const [user] = await db
    .insert(schema.users)
    .values({
      username: args.username,
      passwordHash: hash,
      email: args.email,
      emailVerifiedAt: args.verified ? new Date() : null,
    })
    .returning();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug: `org-${args.username}`, name: args.username })
    .returning();
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role: 'owner' });
  return { userId: user.id, orgId: org.id };
}

async function seedOrgWithCampaign(orgId: number) {
  const db = getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: 'p', name: 'P' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(sql`slug = 'reddit'`);
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'c',
      skillSlug: 'reddit-scout',
    })
    .returning();
  return campaign.id;
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callAndCaptureMail(
  req: Request,
  handler: (event: RequestEvent) => Promise<Response>,
  jar: CookieJar,
  ip: string,
) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  let res: Response;
  let logged: string;
  try {
    res = await runThroughHandle(
      req,
      jar,
      (event) => handler(event as unknown as RequestEvent),
      ip,
    );
    logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    logSpy.mockRestore();
  }
  const match = logged.match(/\/verify\/([0-9a-f]+)/);
  return { res, token: match?.[1] ?? null, logged };
}

describe('email verification (#514)', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  it('a token-less registration sends exactly one verification mail and starts unverified', async () => {
    const jar: CookieJar = { store: new Map() };
    const { res, token, logged } = await callAndCaptureMail(
      jsonRequest('http://localhost/api/auth/register', {
        username: 'freshsignup',
        email: 'fresh@example.com',
        password: 'a-very-long-password',
      }),
      registerPost,
      jar,
      '10.30.0.1',
    );
    expect(res.status).toBe(200);
    expect((await res.json()).emailVerified).toBe(false);
    expect(logged.match(/would send/g)?.length).toBe(1);
    expect(token).toBeTruthy();

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'freshsignup'));
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('a token-less registration renders the welcome/verify mail in the negotiated language (LOR-264)', async () => {
    const jar: CookieJar = { store: new Map() };
    const { res, logged } = await callAndCaptureMail(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'it' },
        body: JSON.stringify({
          username: 'firmaitaliana',
          email: 'italiano@example.com',
          password: 'a-very-long-password',
        }),
      }),
      registerPost,
      jar,
      '10.30.0.2',
    );
    expect(res.status).toBe(200);
    expect(logged).toContain('Benvenuto su Pitchbox');
    expect(logged).not.toContain('Welcome to Pitchbox');
  });

  it('an invite carrying the same address is born verified and sends no mail', async () => {
    const [admin] = await getDb()
      .insert(schema.users)
      .values({ username: 'admin-inv', passwordHash: 'x' })
      .returning();
    const [org] = await getDb()
      .insert(schema.organizations)
      .values({ slug: 'inv-org', name: 'inv-org' })
      .returning();
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: org.id, userId: admin.id, role: 'owner' });
    const invite = await createInvite(getDb(), {
      organizationId: org.id,
      createdByUserId: admin.id,
      email: 'Invited@Example.com',
    });

    const jar: CookieJar = { store: new Map() };
    const { res, logged } = await callAndCaptureMail(
      jsonRequest('http://localhost/api/auth/register', {
        username: 'invitedmatch',
        email: 'invited@example.com',
        password: 'a-very-long-password',
        token: invite.token,
      }),
      registerPost,
      jar,
      '10.30.1.1',
    );
    expect(res.status).toBe(200);
    expect((await res.json()).emailVerified).toBe(true);
    expect(logged).toBe('');

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'invitedmatch'));
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('a verification token works exactly once and an expired one is refused', async () => {
    const jar: CookieJar = { store: new Map() };
    const { token } = await callAndCaptureMail(
      jsonRequest('http://localhost/api/auth/register', {
        username: 'onceonly',
        email: 'once@example.com',
        password: 'a-very-long-password',
      }),
      registerPost,
      jar,
      '10.30.2.1',
    );
    expect(token).toBeTruthy();

    const jar2: CookieJar = { store: new Map() };
    const first = await runThroughHandle(
      jsonRequest('http://localhost/api/auth/verify/confirm', { token }),
      jar2,
      (event) => verifyConfirm(event as unknown as RequestEvent),
      '10.30.2.2',
    );
    expect(first.status).toBe(200);

    const [user] = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'onceonly'));
    expect(user.emailVerifiedAt).not.toBeNull();

    const jar3: CookieJar = { store: new Map() };
    const second = await runThroughHandle(
      jsonRequest('http://localhost/api/auth/verify/confirm', { token }),
      jar3,
      (event) => verifyConfirm(event as unknown as RequestEvent),
      '10.30.2.3',
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'invalid_or_expired_token' });

    // Expired token, independent of use.
    const { token: token2 } = await callAndCaptureMail(
      jsonRequest('http://localhost/api/auth/register', {
        username: 'expiretest',
        email: 'expire@example.com',
        password: 'a-very-long-password',
      }),
      registerPost,
      { store: new Map() },
      '10.30.2.4',
    );
    const tokenHash = createHash('sha256').update(token2!).digest('hex');
    await getDb()
      .update(schema.emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.emailVerificationTokens.tokenHash, tokenHash));
    const expiredRes = await runThroughHandle(
      jsonRequest('http://localhost/api/auth/verify/confirm', { token: token2 }),
      { store: new Map() },
      (event) => verifyConfirm(event as unknown as RequestEvent),
      '10.30.2.5',
    );
    expect(expiredRes.status).toBe(400);
    expect(await expiredRes.json()).toEqual({ error: 'invalid_or_expired_token' });
  });

  it('resend is rate limited per address after the policy max, and skips the limit once already verified', async () => {
    const { userId } = await seedOrgUser({
      username: 'resender',
      email: 'resend@example.com',
      verified: false,
    });
    for (let i = 0; i < 5; i++) {
      const session = await createSession(getDb(), userId);
      const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };
      const res = await runThroughHandle(
        new Request('http://localhost/api/auth/verify/resend', { method: 'POST' }),
        jar,
        (event) => verifyResend(event as unknown as RequestEvent),
        `10.30.3.${i}`,
      );
      expect(res.status).toBe(200);
    }
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };
    const locked = await runThroughHandle(
      new Request('http://localhost/api/auth/verify/resend', { method: 'POST' }),
      jar,
      (event) => verifyResend(event as unknown as RequestEvent),
      '10.30.3.90',
    );
    expect(locked.status).toBe(429);

    const { userId: verifiedId } = await seedOrgUser({
      username: 'alreadyok',
      email: 'ok@example.com',
      verified: true,
    });
    for (let i = 0; i < 7; i++) {
      const s = await createSession(getDb(), verifiedId);
      const j: CookieJar = { store: new Map([['pitchbox_session', { value: s.id }]]) };
      const r = await runThroughHandle(
        new Request('http://localhost/api/auth/verify/resend', { method: 'POST' }),
        j,
        (event) => verifyResend(event as unknown as RequestEvent),
        `10.30.4.${i}`,
      );
      expect(r.status).toBe(200);
      expect((await r.json()).alreadyVerified).toBe(true);
    }
  });

  it('resend renders the verification mail in the language the request negotiates (LOR-264)', async () => {
    const { userId } = await seedOrgUser({
      username: 'resenditaliano',
      email: 'resend-it@example.com',
      verified: false,
    });
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };
    const { res, logged } = await callAndCaptureMail(
      new Request('http://localhost/api/auth/verify/resend', {
        method: 'POST',
        headers: { 'accept-language': 'it' },
      }),
      verifyResend,
      jar,
      '10.30.6.1',
    );
    expect(res.status).toBe(200);
    expect(logged).toContain('Conferma questo indirizzo');
    expect(logged).not.toContain('Confirm this address');
  });

  it("an unverified account's run dispatch is refused server-side with a distinct reason, a verified one is admitted past the gate", async () => {
    const { userId: unverifiedId, orgId: unverifiedOrg } = await seedOrgUser({
      username: 'nogo',
      email: 'nogo@example.com',
      verified: false,
    });
    const campaignId = await seedOrgWithCampaign(unverifiedOrg);
    const unverifiedSession = await createSession(getDb(), unverifiedId);
    const unverifiedJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: unverifiedSession.id }]]),
    };
    await expect(
      runThroughHandle(
        jsonRequest('http://localhost/api/run', { campaignId }),
        unverifiedJar,
        (event) => runPost(event as unknown as RequestEvent),
        '10.30.5.1',
      ),
    ).rejects.toMatchObject({ status: 403, body: { message: 'email_unverified' } });

    const { userId: verifiedId, orgId: verifiedOrg } = await seedOrgUser({
      username: 'gogo',
      email: 'gogo@example.com',
      verified: true,
    });
    const verifiedCampaignId = await seedOrgWithCampaign(verifiedOrg);
    const verifiedSession = await createSession(getDb(), verifiedId);
    const verifiedJar: CookieJar = {
      store: new Map([['pitchbox_session', { value: verifiedSession.id }]]),
    };
    // Past the email gate, it reaches campaign readiness next (the seeded
    // campaign has no config, so it fails there with a plain 422, not the
    // 403 email_unverified refusal) - proof the gate let a verified caller
    // through rather than proof of a full dispatch, which spawns a real
    // agent (see tests/draft-regenerate.test.ts's own note on that).
    const res = await runThroughHandle(
      jsonRequest('http://localhost/api/run', { campaignId: verifiedCampaignId }),
      verifiedJar,
      (event) => runPost(event as unknown as RequestEvent),
      '10.30.5.2',
    );
    expect(res.status).toBe(422);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
});
