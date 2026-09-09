import { json, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { skipOnboarding } from '@pitchbox/shared/onboarding';

/**
 * Dismissing the dashboard banner or the wizard's own "Skip for now" (#516).
 * Records a real decision - `skipped`, not the absence of a row - so the
 * flow never comes back to haunt someone who dismissed it, and stays a
 * no-op once the flow is already `completed`.
 */
export async function POST(event: RequestEvent) {
  const db = getDb();
  const orgId = await requireOrgId(event);
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const userId = event.locals.user?.id ?? null;

  const snapshot = await skipOnboarding(
    db,
    { organizationId: orgId, userId },
    { authOn, username: event.locals.user?.username ?? null },
  );
  return json({ status: snapshot.status });
}
