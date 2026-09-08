import { afterAll, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { POST as promotePost } from '../src/routes/api/settings/admin/promote/+server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';

// Captured at import time (before `runThroughHandle` sets PITCHBOX_AUTH='on')
// so afterAll can restore it and this file doesn't leak the env var into
// other test files sharing this worker. Same convention as
// instance-admin-gating.test.ts.
const originalAuth = process.env.PITCHBOX_AUTH;

async function sessionFor(
  username: string,
  role: 'member' | 'admin' | 'owner',
  isInstanceAdmin: boolean,
): Promise<{ jar: CookieJar; userId: number }> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { passwordHash: hash, isInstanceAdmin },
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
  return {
    jar: { store: new Map([['pitchbox_session', { value: session.id }]]) },
    userId: user.id,
  };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/settings/admin/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function flagFor(userId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ isInstanceAdmin: schema.users.isInstanceAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return !!row?.isInstanceAdmin;
}

// #413: the promote route is the write-side enforcement boundary for
// granting `is_instance_admin` after the deployment's first account has
// already claimed it. Driven through the real hooks.server `handle()`, same
// convention as instance-admin-gating.test.ts, so the session cookie ->
// locals.user -> requireInstanceAdmin DB lookup all run for real.
describe('POST /api/settings/admin/promote (via real handle)', () => {
  it('a member cannot promote themselves (403)', async () => {
    const { jar, userId } = await sessionFor('iap-member-self', 'member', false);
    await expect(runThroughHandle(req({ userId }), jar, promotePost as any)).rejects.toMatchObject({
      status: 403,
    });
    expect(await flagFor(userId)).toBe(false);
  });

  it('an org owner who is not the instance admin cannot promote anyone (403)', async () => {
    const { jar } = await sessionFor('iap-owner-notadmin', 'owner', false);
    const { userId: targetId } = await sessionFor('iap-owner-target', 'member', false);
    await expect(
      runThroughHandle(req({ userId: targetId }), jar, promotePost as any),
    ).rejects.toMatchObject({ status: 403 });
    expect(await flagFor(targetId)).toBe(false);
  });

  it('an instance admin can promote a second, later-created account (200), proving the account is not required to be first to log in', async () => {
    const { jar } = await sessionFor('iap-bootstrap-admin', 'owner', true);
    // The second account: created after the first, ordinary member, never
    // logged in first - exactly the deployment shape #413 closes.
    const { userId: secondAccountId } = await sessionFor('iap-second-account', 'member', false);
    expect(await flagFor(secondAccountId)).toBe(false);

    const res = await runThroughHandle(req({ userId: secondAccountId }), jar, promotePost as any);
    expect(res.status).toBe(200);
    expect(await flagFor(secondAccountId)).toBe(true);
  });

  it('promoting an unknown user id 404s', async () => {
    const { jar } = await sessionFor('iap-admin-404', 'owner', true);
    await expect(
      runThroughHandle(req({ userId: 999999 }), jar, promotePost as any),
    ).rejects.toMatchObject({ status: 404 });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
