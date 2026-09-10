import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { hashPassword } from '@pitchbox/shared/auth';
import { actions, load } from '../src/routes/settings/retention/+page.server.js';

// The retention page saves via a SvelteKit form action, not the /api routes,
// so its gate lives on the action itself. Retention is a single instance-wide
// app_config row (like default runner, quota defaults, and webhook config),
// not per-org data, so saving it must be requireInstanceAdmin-gated, not just
// requireRole('admin') - a self-created-org admin must not be able to change
// retention for every tenant (#137 follow-up; see
// instance-admin-gating.test.ts for the sibling /api routes in this family).

const PASSWORD = 'correct-horse-battery';

async function userWith(username: string, isInstanceAdmin: boolean): Promise<{ id: number }> {
  const hash = await hashPassword(PASSWORD);
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin })
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { isInstanceAdmin },
    });
  const [user] = await getDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  return user;
}
function ev(user?: { id: number }, org?: { role: 'member' | 'admin' | 'owner' }): RequestEvent {
  return {
    locals: {
      ...(user ? { user } : {}),
      ...(org ? { org: { id: 1, slug: 'x', role: org.role } } : {}),
    },
    request: new Request('http://x/', { method: 'POST' }),
    url: new URL('http://x/settings/retention'),
  } as unknown as RequestEvent;
}

const run = actions.default as (e: RequestEvent) => Promise<unknown>;
const loadFn = load as (e: RequestEvent) => Promise<unknown>;

describe('retention form action instance-admin gate', () => {
  it('rejects an org admin who is not instance-admin with 403', async () => {
    const user = await userWith('retention-role-admin', false);
    await expect(run(ev(user))).rejects.toMatchObject({ status: 403 });
  });
  it('does not 403 an instance-admin (passes the gate)', async () => {
    const user = await userWith('retention-role-iadmin', true);
    const res = (await run(ev(user)).catch((e) => e)) as { status?: number };
    expect(res?.status).not.toBe(403);
  });
  it('does not 403 with auth off (no locals.user)', async () => {
    const res = (await run(ev()).catch((e) => e)) as { status?: number };
    expect(res?.status).not.toBe(403);
  });
});

// #183: viewing retention describes the whole deployment (like the write
// side above), so on cloud the per-org 'admin' role is not the right axis
// either - any user can self-create an org and become its admin/owner. The
// load gate narrows to requireInstanceAdmin there too; self-host keeps the
// unchanged requireRole('admin') gate.
describe('retention +page.server.ts load: edition-aware view gate (#183)', () => {
  describe('self-hosted (edition unset): unchanged requireRole(admin) gate', () => {
    it('throws 403 for a plain member', async () => {
      await expect(loadFn(ev(undefined, { role: 'member' }))).rejects.toMatchObject({
        status: 403,
      });
    });
    it('does not throw for an org admin', async () => {
      const res = (await loadFn(ev(undefined, { role: 'admin' })).catch((e) => e)) as {
        status?: number;
      };
      expect(res?.status).not.toBe(403);
    });
    it('does not throw with no org context at all (auth off)', async () => {
      const res = (await loadFn(ev()).catch((e) => e)) as { status?: number };
      expect(res?.status).not.toBe(403);
    });
  });

  describe('cloud', () => {
    const savedEdition = process.env.PITCHBOX_EDITION;
    beforeEach(() => {
      process.env.PITCHBOX_EDITION = 'cloud';
    });
    afterEach(() => {
      if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
      else process.env.PITCHBOX_EDITION = savedEdition;
    });

    it('throws 403 for a plain member', async () => {
      const user = await userWith('retention-load-cloud-member', false);
      await expect(loadFn(ev(user, { role: 'member' }))).rejects.toMatchObject({ status: 403 });
    });
    it('throws 403 for an org owner who is not the instance admin', async () => {
      const user = await userWith('retention-load-cloud-owner', false);
      await expect(loadFn(ev(user, { role: 'owner' }))).rejects.toMatchObject({
        status: 403,
      });
    });
    it('does not throw for the instance admin', async () => {
      const user = await userWith('retention-load-cloud-iadmin', true);
      const res = (await loadFn(ev(user, { role: 'member' })).catch((e) => e)) as {
        status?: number;
      };
      expect(res?.status).not.toBe(403);
    });
  });
});
