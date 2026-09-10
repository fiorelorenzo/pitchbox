import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import { listOrgPlans } from '@pitchbox/shared/orgs';
import { listPlans } from '@pitchbox/shared/plans';

// Instance-admin plan grants (#187). The area's `+layout.server.ts` already
// gates the whole subtree; this loader gates itself again the same way
// settings/admin/models and settings/admin/spend-ceiling do - the write path
// next door (api/settings/admin/org-plans) does the same, and that API is
// the boundary that holds when somebody types a URL rather than following a
// link that was hidden from them.
export const load: PageServerLoad = async (event) => {
  await requireInstanceAdmin(event);
  const orgs = await listOrgPlans(getDb());
  return {
    orgs,
    plans: listPlans().map((plan) => ({ id: plan.id, name: plan.name })),
  };
};
