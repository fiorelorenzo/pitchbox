import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { json } from '@sveltejs/kit';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession, setSessionActiveOrg } from '@pitchbox/shared/auth';
import { POST as changeLocale } from '../src/routes/api/auth/locale/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

/**
 * POST /api/auth/locale (LOR-262): the dashboard's self-service half of the
 * account-wide language override, the write path
 * shared/tests/auth.test.ts's `getUserLocale`/`setUserLocale` test already
 * covers directly. What's worth an HTTP-level test here is the real
 * `handle()` wiring: a signed-in write actually changes what the very next
 * request's `event.locals.locale` resolves to, proving the
 * hooks.server.ts LOR-262 attach point is real, not merely the unit-level
 * `resolveLocale` precedence web/tests/i18n.test.ts already defends.
 */

const PASSWORD = 'correct-horse-battery';

async function reset() {
  await getDb().execute(sql`DELETE FROM sessions`);
  await getDb().execute(sql`DELETE FROM memberships`);
  await getDb().execute(sql`DELETE FROM users`);
}

async function seedUser(username: string): Promise<number> {
  const hash = await hashPassword(PASSWORD);
  const [row] = await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash })
    .returning();
  // hooks.server.ts 404s a signed-in request with no resolvable
  // organization (#132's multi-tenant phase 2 guard) before it ever
  // reaches a route handler - every other test file driving a session
  // through the real handle() seeds this membership for exactly that
  // reason (see password-change.test.ts's own seedUser).
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
    .values({ organizationId: org.id, userId: row.id, role: 'owner' })
    .onConflictDoNothing();
  return row.id;
}

function localeRequest(body: unknown): Request {
  return new Request('http://localhost/api/auth/locale', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A minimal stand-in route, not a real app page: proves what
// hooks.server.ts's `handle()` actually populated on `event.locals.locale`
// for this request, independent of any page's own rendering.
function readLocale(event: { locals: { locale: string } }) {
  return Promise.resolve(json({ locale: event.locals.locale }));
}

// runThroughHandle's `routeHandler` is deliberately typed `(event: unknown)
// => Promise<Response>` (see handle-harness.ts) since it hands off whatever
// shape `handle()` itself produced - a real SvelteKit route handler always
// expects a narrower, concrete event shape, so satisfying that parameter
// needs an explicit cast at this one boundary.
const changeLocaleHandler = changeLocale as unknown as (event: unknown) => Promise<Response>;
const readLocaleHandler = readLocale as unknown as (event: unknown) => Promise<Response>;

describe('POST /api/auth/locale', () => {
  beforeEach(async () => {
    process.env.PITCHBOX_AUTH = 'on';
    await reset();
  });

  it('rejects an unauthenticated request (401 from the route itself)', async () => {
    // No session cookie at all - hooks.server.ts's own AUTH_ON gate already
    // 401s an unauthenticated /api/* request before this route ever runs,
    // so this is really exercising the hook, not the route's own `!user`
    // check.
    const jar: CookieJar = { store: new Map() };
    const res = await runThroughHandle(localeRequest({ locale: 'it' }), jar, changeLocaleHandler);
    expect(res.status).toBe(401);
  });

  it('rejects a locale outside the supported set (400), and leaves the stored value untouched', async () => {
    const userId = await seedUser('loc-web-invalid');
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };

    // The route throws SvelteKit's `error(400, ...)`, which propagates as a
    // rejection rather than a 400 Response - unlike hooks.server.ts's own
    // early-return Responses (the 401 case above).
    await expect(
      runThroughHandle(localeRequest({ locale: 'fr' }), jar, changeLocaleHandler),
    ).rejects.toMatchObject({ status: 400 });

    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row.locale).toBeNull();
  });

  it('a signed-in write changes what the very next request resolves through the real hook', async () => {
    const userId = await seedUser('loc-web-valid');
    const session = await createSession(getDb(), userId);
    const jar: CookieJar = { store: new Map([['pitchbox_session', { value: session.id }]]) };

    const before = await runThroughHandle(
      new Request('http://localhost/x', { headers: { accept: 'application/json' } }),
      jar,
      readLocaleHandler,
    );
    expect((await before.json()).locale).toBe('en');

    const writeRes = await runThroughHandle(
      localeRequest({ locale: 'it' }),
      jar,
      changeLocaleHandler,
    );
    expect(writeRes.status).toBe(200);
    expect(await writeRes.json()).toEqual({ ok: true, locale: 'it' });

    const after = await runThroughHandle(
      new Request('http://localhost/x', { headers: { accept: 'application/json' } }),
      jar,
      readLocaleHandler,
    );
    expect((await after.json()).locale).toBe('it');
  });

  // Required by the issue: "say in the PR what a second organization, or a
  // user in two organizations, resolves to." The column lives on `users`,
  // never on `memberships`/`organizations`, so there is no code path that
  // could tie it to an org at all - this proves it rather than arguing it
  // from the schema alone.
  it("a second organization's member has an independent locale, and switching active org never changes this user's own", async () => {
    const userA = await seedUser('loc-multi-a');
    const [orgB] = await getDb()
      .insert(schema.organizations)
      .values({ slug: 'loc-org-b', name: 'loc-org-b' })
      .returning();
    const userB = await seedUser('loc-multi-b');
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: orgB.id, userId: userB, role: 'owner' })
      .onConflictDoNothing();
    // userA also joins orgB, as a second org for the same person - the
    // scenario the issue specifically asks about.
    await getDb()
      .insert(schema.memberships)
      .values({ organizationId: orgB.id, userId: userA, role: 'member' });

    const sessionA = await createSession(getDb(), userA);
    const sessionB = await createSession(getDb(), userB);
    const jarA: CookieJar = { store: new Map([['pitchbox_session', { value: sessionA.id }]]) };
    const jarB: CookieJar = { store: new Map([['pitchbox_session', { value: sessionB.id }]]) };

    await runThroughHandle(localeRequest({ locale: 'it' }), jarA, changeLocaleHandler);
    await runThroughHandle(localeRequest({ locale: 'en' }), jarB, changeLocaleHandler);

    const readReq = () =>
      new Request('http://localhost/x', { headers: { accept: 'application/json' } });

    // userB's own preference is untouched by userA's write, even though
    // both are members of orgB.
    const bResolved = await runThroughHandle(readReq(), jarB, readLocaleHandler);
    expect((await bResolved.json()).locale).toBe('en');

    // userA still resolves 'it' while active on the 'default' org...
    const aOnDefault = await runThroughHandle(readReq(), jarA, readLocaleHandler);
    expect((await aOnDefault.json()).locale).toBe('it');

    // ...and still resolves 'it' after switching their active org to orgB -
    // the preference travels with the person, not with which org they're
    // currently looking at.
    await setSessionActiveOrg(getDb(), sessionA.id, orgB.id);
    const aOnOrgB = await runThroughHandle(readReq(), jarA, readLocaleHandler);
    expect((await aOnOrgB.json()).locale).toBe('it');
  });
});

afterAll(async () => {
  delete process.env.PITCHBOX_AUTH;
});
