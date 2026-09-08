import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { load as adminAreaLoad } from '../src/routes/settings/admin/+layout.server.js';
import { load as rootLayoutLoad } from '../src/routes/+layout.server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

const PASSWORD = 'correct-horse-battery';

// Captured at import time (before `runThroughHandle` sets PITCHBOX_AUTH='on')
// so afterAll can restore it and this file doesn't leak the env var into
// other test files sharing this worker.
const originalAuth = process.env.PITCHBOX_AUTH;

// Ensures a user exists in the default org with the given role and
// instance-admin flag, and returns a cookie jar carrying a live session for
// them, for driving requests through the real hooks.server handle() - same
// pattern as instance-admin-gating.test.ts, so `locals.user` and the
// requireInstanceAdmin DB lookup are both exercised for real rather than
// hand-injected.
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

// No `locals.user` at all: exactly what hooks.server.ts leaves in place when
// PITCHBOX_AUTH is off (its `if (AUTH_ON && ...)` block never runs, so
// locals.user is never assigned regardless of any cookie), same convention
// as settings-gating.test.ts's `loaderEvent(null)`.
function authOffEvent(): RequestEvent {
  return { locals: {} } as unknown as RequestEvent;
}

// `rootLayoutLoad` is typed against the generic `LayoutServerLoad` (see
// $types), whose default OutputData includes `| void` - narrow to the one
// field these tests read, same as layout-orgs.test.ts's `LoadResult`.
type RootLayoutData = { isInstanceAdmin: boolean };

describe('settings/admin area gating (#412)', () => {
  // The whole area gates once, in settings/admin/+layout.server.ts, rather
  // than per-page - a later sibling page under settings/admin/ (#411's model
  // configuration) inherits this for free. These tests exercise that one
  // loader; a page-level test would only prove the layout wraps it, which
  // SvelteKit's own routing already guarantees.
  describe('settings/admin/+layout.server.ts load', () => {
    it('an org owner who is not instance-admin is forbidden (403)', async () => {
      const jar = await sessionFor('sag-owner', 'owner', false);
      const req = new Request('http://localhost/settings/admin');
      await expect(
        runThroughHandle(req, jar, async (event) => {
          await adminAreaLoad(event as Parameters<typeof adminAreaLoad>[0]);
          return new Response(null);
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('a member is forbidden (403)', async () => {
      const jar = await sessionFor('sag-member', 'member', false);
      const req = new Request('http://localhost/settings/admin');
      await expect(
        runThroughHandle(req, jar, async (event) => {
          await adminAreaLoad(event as Parameters<typeof adminAreaLoad>[0]);
          return new Response(null);
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('the instance admin can load it (200)', async () => {
      const jar = await sessionFor('sag-iadmin', 'member', true);
      const req = new Request('http://localhost/settings/admin');
      const res = await runThroughHandle(req, jar, async (event) => {
        await adminAreaLoad(event as Parameters<typeof adminAreaLoad>[0]);
        return new Response(null);
      });
      expect(res.status).toBe(200);
    });

    it('auth off has full access (200)', async () => {
      await expect(
        adminAreaLoad(authOffEvent() as Parameters<typeof adminAreaLoad>[0]),
      ).resolves.toEqual({});
    });
  });

  describe('root +layout.server.ts: isInstanceAdmin flag', () => {
    it('is false for a signed-in user who is not the instance admin', async () => {
      const hash = await hashPassword(PASSWORD);
      await getDb()
        .insert(schema.users)
        .values({ username: 'sag-layout-plain', passwordHash: hash, isInstanceAdmin: false })
        .onConflictDoUpdate({
          target: schema.users.username,
          set: { isInstanceAdmin: false },
        });
      const [user] = await getDb()
        .select()
        .from(schema.users)
        .where(sql`username = 'sag-layout-plain'`);
      const data = (await rootLayoutLoad({
        locals: { user: { id: user.id, username: user.username } },
      } as unknown as Parameters<typeof rootLayoutLoad>[0])) as RootLayoutData;
      expect(data.isInstanceAdmin).toBe(false);
    });

    it('is true for the instance admin', async () => {
      const hash = await hashPassword(PASSWORD);
      await getDb()
        .insert(schema.users)
        .values({ username: 'sag-layout-iadmin', passwordHash: hash, isInstanceAdmin: true })
        .onConflictDoUpdate({
          target: schema.users.username,
          set: { isInstanceAdmin: true },
        });
      const [user] = await getDb()
        .select()
        .from(schema.users)
        .where(sql`username = 'sag-layout-iadmin'`);
      const data = (await rootLayoutLoad({
        locals: { user: { id: user.id, username: user.username } },
      } as unknown as Parameters<typeof rootLayoutLoad>[0])) as RootLayoutData;
      expect(data.isInstanceAdmin).toBe(true);
    });

    it('is true when signed out / auth off', async () => {
      const data = (await rootLayoutLoad(
        authOffEvent() as unknown as Parameters<typeof rootLayoutLoad>[0],
      )) as RootLayoutData;
      expect(data.isInstanceAdmin).toBe(true);
    });
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
