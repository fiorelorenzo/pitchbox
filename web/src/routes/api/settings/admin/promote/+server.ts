import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import { setInstanceAdmin } from '@pitchbox/shared/auth';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { schema } from '$lib/server/db.js';
import { eq } from 'drizzle-orm';

const Body = z.object({ userId: z.number().int().positive() });

// The write side of #413: grants `users.is_instance_admin` to an existing
// account so the operator of a deployment where they weren't the first to
// log in can still become the instance admin, once someone who already
// holds the flag promotes them. `requireInstanceAdmin` is the real
// enforcement boundary here, same convention as every other instance-wide
// config route (docs/permissions.md "Instance admin") - the button on
// settings/admin is presentation, not the gate. Routes through
// `setInstanceAdmin` (shared/src/auth.ts), the same function `createUser`
// uses for the first-login/seed:owner bootstrap grant, so there is exactly
// one place that ever writes this column true.
export async function POST(event: RequestEvent) {
  await requireInstanceAdmin(event);
  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  const [user] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      isInstanceAdmin: schema.users.isInstanceAdmin,
    })
    .from(schema.users)
    .where(eq(schema.users.id, parsed.data.userId))
    .limit(1);
  if (!user) throw error(404, 'not_found');

  await setInstanceAdmin(db, user.id, true);
  // #414: instance-wide config writes (this one included) are expected to
  // record themselves - a route that forgets is the only way this trail
  // goes missing.
  await recordInstanceAudit(db, {
    key: 'user_promotion',
    actor: event.locals.user ?? null,
    before: { username: user.username, isInstanceAdmin: user.isInstanceAdmin },
    after: { username: user.username, isInstanceAdmin: true },
  });
  return json({ ok: true, userId: user.id });
}
