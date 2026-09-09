import { getDb } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { getOnboardingSnapshot } from '@pitchbox/shared/onboarding';
import type { PageServerLoad } from './$types';

/**
 * Settings home for the onboarding flow (#516): a read-only status card plus
 * the one action every terminal state needs, "Start again". No loader
 * throws on a role - restarting a walkthrough is self-service, the same as
 * `/settings/password`, not an org-admin power.
 */
export const load: PageServerLoad = async (event) => {
  const db = getDb();
  const orgId = await requireOrgId(event);
  const authOn = process.env.PITCHBOX_AUTH === 'on';
  const userId = event.locals.user?.id ?? null;
  const username = event.locals.user?.username ?? null;

  const snapshot = await getOnboardingSnapshot(
    db,
    { organizationId: orgId, userId },
    { authOn, username },
  );

  return { snapshot };
};
