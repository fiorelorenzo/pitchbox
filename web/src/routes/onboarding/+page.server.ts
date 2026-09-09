import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { startOnboarding } from '@pitchbox/shared/onboarding';
import type { PageServerLoad } from './$types';

/**
 * Visiting this page is what starts the flow (#516): `startOnboarding` is a
 * no-op unless the identity's row is missing or `not_started`, so a repeat
 * visit while `in_progress` just re-reads the current snapshot, and a
 * `skipped`/`completed` visit renders this page's own terminal-state view
 * rather than silently resuming - only the explicit "Start again" action
 * (POST /api/onboarding/restart) reopens those.
 */
export const load: PageServerLoad = async (event) => {
  const db = getDb();
  const orgId = await requireOrgId(event);
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const userId = event.locals.user?.id ?? null;
  const username = event.locals.user?.username ?? null;

  const snapshot = await startOnboarding(
    db,
    { organizationId: orgId, userId },
    { authOn, username },
  );

  const [firstProject] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, orgId))
    .orderBy(schema.projects.id)
    .limit(1);

  return { snapshot, firstProjectId: firstProject?.id ?? null };
};
