import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { hashPassword } from '@pitchbox/shared/auth';
import { actions } from '../src/routes/settings/retention/+page.server.js';

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

function ev(user?: { id: number }): RequestEvent {
  return {
    locals: user ? { user } : {},
    request: new Request('http://x/', { method: 'POST' }),
  } as unknown as RequestEvent;
}

const run = actions.default as (e: RequestEvent) => Promise<unknown>;

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
