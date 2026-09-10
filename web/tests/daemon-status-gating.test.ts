import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { GET as daemonStatusGet } from '../src/routes/api/daemon/status/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';

// Captured at import time (before `runThroughHandle` sets PITCHBOX_AUTH='on')
// so afterAll can restore it and this file doesn't leak the env var into
// other test files sharing this worker - same convention as
// instance-admin-gating.test.ts.
const originalAuth = process.env.PITCHBOX_AUTH;
const originalEdition = process.env.PITCHBOX_EDITION;

// Same shape as instance-admin-gating.test.ts's sessionFor (no shared
// factory exists across these gating suites) - driven through the REAL
// hooks.server `handle()` so the session cookie -> locals.user ->
// requireInstanceAdmin's own DB lookup all run for real.
async function sessionFor(
  username: string,
  role: 'member' | 'admin' | 'owner',
  isInstanceAdmin: boolean,
): Promise<CookieJar> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { isInstanceAdmin },
    });
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

// #184: the daemon's module list is a description of what the deployment
// runs, so on cloud it is instance-admin information the same way
// default-runner/quota/webhooks are (docs/permissions.md "Instance admin"),
// not a per-org role or a bare session. On self-host it stays fully open -
// that is the operator's own dashboard.
describe('GET /api/daemon/status (cloud edition, via real handle)', () => {
  beforeAll(async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    await getDb().execute(sql`TRUNCATE daemon_heartbeats`);
    await getDb().insert(schema.daemonHeartbeats).values({ module: 'daemon', tickAt: new Date() });
  });

  afterAll(() => {
    if (originalEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = originalEdition;
  });

  it('an unauthenticated request is refused (401)', async () => {
    const req = new Request('http://localhost/api/daemon/status');
    const res = await runThroughHandle(req, { store: new Map() }, daemonStatusGet as never);
    expect(res.status).toBe(401);
  });

  it('a plain member is forbidden (403) - no daemon state leaks to a tenant', async () => {
    const jar = await sessionFor('dsg-member', 'member', false);
    const req = new Request('http://localhost/api/daemon/status');
    await expect(runThroughHandle(req, jar, daemonStatusGet as never)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('an org owner who is not the instance admin is still forbidden (403)', async () => {
    const jar = await sessionFor('dsg-owner', 'owner', false);
    const req = new Request('http://localhost/api/daemon/status');
    await expect(runThroughHandle(req, jar, daemonStatusGet as never)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('the instance admin gets the payload (200)', async () => {
    const jar = await sessionFor('dsg-iadmin', 'member', true);
    const req = new Request('http://localhost/api/daemon/status');
    const res = await runThroughHandle(req, jar, daemonStatusGet as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alive: boolean; modules: Array<{ module: string }> };
    expect(body.alive).toBe(true);
    expect(body.modules.some((m) => m.module === 'daemon')).toBe(true);
  });
});

describe('GET /api/daemon/status (self-hosted edition)', () => {
  it('a caller with no session at all still gets the payload (unchanged)', async () => {
    process.env.PITCHBOX_EDITION = 'self-hosted';
    const res = await daemonStatusGet({ locals: {} } as unknown as RequestEvent);
    expect(res.status).toBe(200);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  if (originalEdition === undefined) delete process.env.PITCHBOX_EDITION;
  else process.env.PITCHBOX_EDITION = originalEdition;
  await getPool().end();
});
