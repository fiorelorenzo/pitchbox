import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import {
  loadInstanceQuotaCeiling,
  loadSelfRegistrationQuotaDefaults,
  getInstanceMonthToDateCostUsd,
  getInstanceQuotaSnapshot,
} from '@pitchbox/shared/org-quota';

// The two gates on opening registration (#423) to strangers - #540. The
// area's `+layout.server.ts` already gates the whole subtree; this loader
// gates itself again the same way settings/admin/models does: the write
// path next door does the same, and the API is the boundary that holds
// when somebody types a URL rather than following a link that was hidden
// from them.
export const load: PageServerLoad = async (event) => {
  await requireInstanceAdmin(event);
  const db = getDb();
  const [ceiling, selfRegistrationDefaults, monthToDateCostUsd, snapshot] = await Promise.all([
    loadInstanceQuotaCeiling(db),
    loadSelfRegistrationQuotaDefaults(db),
    getInstanceMonthToDateCostUsd(db),
    getInstanceQuotaSnapshot(db),
  ]);
  return {
    instanceMonthlyBudgetUsd: ceiling.monthlyBudgetUsd,
    selfRegistrationMonthlyRunBudgetUsd: selfRegistrationDefaults.monthlyRunBudgetUsd,
    selfRegistrationMaxConcurrentRuns: selfRegistrationDefaults.maxConcurrentRuns,
    monthToDateCostUsd,
    remainingUsd: snapshot.remainingUsd,
  };
};
