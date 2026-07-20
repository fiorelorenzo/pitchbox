import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireOrgId, requireRole } from '$lib/server/auth.js';
import {
  getOrgMonthToDateCostUsd,
  getOrgQuotaFields,
  getOrgQuotaSnapshot,
  setOrgQuota,
} from '@pitchbox/shared/org-quota';

// GET + PUT the caller's own org's cloud-runner quota (#161,
// docs/cloud-runner-productionization-design.md section 5): the monthly USD
// run budget and the concurrency cap stored on `organizations`, both
// nullable (null = unlimited). Org-scoped via requireOrgId (the orgId always
// comes from the caller's own session, never from the request body/params, so
// there is no way to read or write another org's row) and role-gated to
// admin - the same level as the Organization settings section's other
// mutations (renaming the org, member management; docs/permissions.md).

const PutBody = z.object({
  monthlyRunBudgetUsd: z.number().finite().nonnegative().nullable(),
  maxConcurrentRuns: z.number().int().nonnegative().nullable(),
});

async function quotaResponse(orgId: number) {
  const db = getDb();
  const fields = await getOrgQuotaFields(db, orgId);
  if (!fields) throw error(404, 'not_found');
  const [monthToDateCostUsd, snapshot] = await Promise.all([
    getOrgMonthToDateCostUsd(db, orgId),
    getOrgQuotaSnapshot(db, orgId),
  ]);
  return json({
    monthlyRunBudgetUsd: fields.monthlyRunBudgetUsd,
    maxConcurrentRuns: fields.maxConcurrentRuns,
    monthToDateCostUsd,
    remainingUsd: snapshot.remainingUsd,
  });
}

export async function GET(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');
  return quotaResponse(orgId);
}

export async function PUT(event: RequestEvent) {
  const orgId = await requireOrgId(event);
  requireRole(event, 'admin');
  const parsed = PutBody.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) throw error(400, 'invalid_body');
  const updated = await setOrgQuota(getDb(), orgId, parsed.data);
  if (!updated) throw error(404, 'not_found');
  return quotaResponse(orgId);
}
