import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import {
  loadRegistrationPolicy,
  saveRegistrationPolicy,
} from '@pitchbox/shared/registration-policy';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';

const Body = z.object({ policy: z.enum(['open', 'invite', 'off']) });

// The registration policy switch (#505): instance-wide, like default-runner/
// quota/retention/webhooks/model-functions, so it needs the stricter
// `requireInstanceAdmin` rather than the per-org 'admin' role - a
// self-created-org admin must never be able to open sign-up for the whole
// deployment.
export async function GET(event: RequestEvent) {
  await requireInstanceAdmin(event);
  return json({ policy: await loadRegistrationPolicy(getDb()) });
}

export async function POST(event: RequestEvent) {
  await requireInstanceAdmin(event);
  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  const before = await loadRegistrationPolicy(db);
  const after = await saveRegistrationPolicy(db, parsed.data.policy);
  await recordInstanceAudit(db, {
    key: 'registration_policy',
    actor: event.locals.user ?? null,
    before: { policy: before },
    after: { policy: after },
  });
  return json({ ok: true, policy: after });
}
