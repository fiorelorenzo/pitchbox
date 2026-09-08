import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { POST as runPost } from '../src/routes/api/run/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';
const INTERNAL_TOKEN = 'w378-test-internal-token-0123456789abcdef';
// Same length as INTERNAL_TOKEN (differs in the last byte only), so a wrong
// guess exercises the real timingSafeEqual comparison rather than being
// rejected purely by the length guard.
const WRONG_TOKEN = `${INTERNAL_TOKEN.slice(0, -1)}${INTERNAL_TOKEN.endsWith('f') ? 'e' : 'f'}`;

// Captured before we touch either env var below, so afterAll can restore
// both and this file doesn't leak them into other test files sharing this
// worker. hooks.server.ts reads both into module-level constants at import
// time (see helpers/handle-harness.ts's comment on PITCHBOX_AUTH), so
// PITCHBOX_INTERNAL_TOKEN must be set before the first runThroughHandle call
// in this file - a static top-of-file import would evaluate too early.
const originalAuth = process.env.PITCHBOX_AUTH;
const originalInternalToken = process.env.PITCHBOX_INTERNAL_TOKEN;
process.env.PITCHBOX_INTERNAL_TOKEN = INTERNAL_TOKEN;

// An id nothing seeds. getCampaignReadiness() returns `ready: false` for an
// unknown campaign with no DB write, so the REAL /api/run route handler (not
// a hand-rolled stand-in) can prove a request reached it - 422 "not_ready"
// instead of 401 "unauthenticated" - without spawning a real campaign run.
const UNKNOWN_CAMPAIGN_ID = 999_999_999;

function dispatchRequest(campaignId: number, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ campaignId, trigger: 'scheduled' }),
  });
}

const emptyJar: CookieJar = { store: new Map() };

// Ensures a user exists in the default org and returns a cookie jar carrying
// a live session, for driving a request through the real hooks.server
// handle() below - same pattern as settings-gating.test.ts's sessionFor.
async function sessionFor(username: string): Promise<{ jar: CookieJar; orgId: number }> {
  const hash = await hashPassword(PASSWORD);
  await getDb().insert(schema.users).values({ username, passwordHash: hash }).onConflictDoNothing();
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
    .values({ organizationId: org.id, userId: user.id, role: 'member' })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { role: 'member' },
    });
  const session = await createSession(getDb(), user.id);
  return { jar: { store: new Map([['pitchbox_session', { value: session.id }]]) }, orgId: org.id };
}

// A real campaign scoped to the session's org, since the route's own
// campaignBelongsToOrg check (which only runs when a session sets
// locals.org - see the route comment) would 404 an unowned id before
// readiness is even checked, unlike the no-session path below.
async function seedCampaignForOrg(orgId: number): Promise<number> {
  const db = getDb();
  await db
    .insert(schema.projects)
    .values({
      organizationId: orgId,
      slug: 'internal-dispatch-proj',
      name: 'internal-dispatch-proj',
    })
    .onConflictDoNothing();
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(sql`organization_id = ${orgId} and slug = 'internal-dispatch-proj'`);
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: 'internal-dispatch-campaign',
      skillSlug: 'reddit-scout',
    })
    .returning();
  return campaign.id;
}

// #378: the daemon's scheduled/keyword-triggered dispatch to POST /api/run
// carries no browser session, so PITCHBOX_AUTH=on rejected it outright and no
// cron campaign could ever run. These drive requests through the REAL
// hooks.server handle() and the REAL /api/run route handler (not a
// hand-rolled stand-in), so both the hook's internal-token bypass and the
// route's own no-org handling are proven together, exactly as a live daemon
// dispatch would exercise them.
describe('internal dispatch token on POST /api/run (real handle + route)', () => {
  it('no session and no token is rejected (401)', async () => {
    const res = await runThroughHandle(
      dispatchRequest(UNKNOWN_CAMPAIGN_ID),
      emptyJar,
      runPost as any,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthenticated');
  });

  it('no session and a wrong token is rejected (401)', async () => {
    const res = await runThroughHandle(
      dispatchRequest(UNKNOWN_CAMPAIGN_ID, { authorization: `Bearer ${WRONG_TOKEN}` }),
      emptyJar,
      runPost as any,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthenticated');
  });

  it('no session and the right token reaches the route (422 not_ready, not 401)', async () => {
    const res = await runThroughHandle(
      dispatchRequest(UNKNOWN_CAMPAIGN_ID, { authorization: `Bearer ${INTERNAL_TOKEN}` }),
      emptyJar,
      runPost as any,
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('not_ready');
  });

  it('a real session with no token still works (422 not_ready, not 401)', async () => {
    const { jar, orgId } = await sessionFor('internal-dispatch-session-user');
    const campaignId = await seedCampaignForOrg(orgId);
    const res = await runThroughHandle(dispatchRequest(campaignId), jar, runPost as any);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('not_ready');
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  if (originalInternalToken === undefined) delete process.env.PITCHBOX_INTERNAL_TOKEN;
  else process.env.PITCHBOX_INTERNAL_TOKEN = originalInternalToken;
  await getPool().end();
});
