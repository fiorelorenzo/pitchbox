import { json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { restartOnboarding } from '@pitchbox/shared/onboarding';

/**
 * Settings > Onboarding "Start again" (#516). Valid from every status,
 * including the two terminal ones - this is how a demo or a support call
 * ("run through it again with me") restarts the flow. A step whose
 * condition is already satisfied still reads as done immediately after -
 * restarting never re-creates anything, it only re-opens the checklist.
 */
export async function POST(event: RequestEvent) {
  const db = getDb();
  const orgId = await requireOrgId(event);
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const userId = event.locals.user?.id ?? null;

  const snapshot = await restartOnboarding(
    db,
    { organizationId: orgId, userId },
    { authOn, username: event.locals.user?.username ?? null },
  );
  return json({ status: snapshot.status });
}
