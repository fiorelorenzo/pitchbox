import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import {
  loadInstanceQuotaCeiling,
  saveInstanceQuotaCeiling,
  loadSelfRegistrationQuotaDefaults,
  saveSelfRegistrationQuotaDefaults,
  getInstanceMonthToDateCostUsd,
  getInstanceQuotaSnapshot,
} from '@pitchbox/shared/org-quota';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';

// GET + PUT the two #540 knobs behind opening registration (#423) to strangers:
// the instance-wide monthly Gateway ceiling (web/src/lib/server/runner.ts checks
// it next to the per-org budget) and the caps a self-registered org starts with
// (shared/src/orgs.ts's createOrganization, `self_registration` quotaSource).
// Instance-wide config like default-runner/quota/retention/webhooks, so both
// GET and PUT need the stricter requireInstanceAdmin rather than the per-org
// 'admin' role - a self-created-org admin must never see or raise the ceiling
// that is meant to bound exactly that kind of org.

const Body = z.object({
  instanceMonthlyBudgetUsd: z.number().finite().nonnegative().nullable(),
  selfRegistrationMonthlyRunBudgetUsd: z.number().finite().positive(),
  selfRegistrationMaxConcurrentRuns: z.number().int().positive(),
});

async function spendCeilingResponse() {
  const db = getDb();
  const [ceiling, selfRegistrationDefaults, monthToDateCostUsd, snapshot] = await Promise.all([
    loadInstanceQuotaCeiling(db),
    loadSelfRegistrationQuotaDefaults(db),
    getInstanceMonthToDateCostUsd(db),
    getInstanceQuotaSnapshot(db),
  ]);
  return json({
    instanceMonthlyBudgetUsd: ceiling.monthlyBudgetUsd,
    selfRegistrationMonthlyRunBudgetUsd: selfRegistrationDefaults.monthlyRunBudgetUsd,
    selfRegistrationMaxConcurrentRuns: selfRegistrationDefaults.maxConcurrentRuns,
    monthToDateCostUsd,
    remainingUsd: snapshot.remainingUsd,
  });
}

export async function GET(event: RequestEvent) {
  await requireInstanceAdmin(event);
  return spendCeilingResponse();
}

export async function PUT(event: RequestEvent) {
  await requireInstanceAdmin(event);
  const raw = await event.request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');

  const db = getDb();
  const before = {
    instanceCeiling: await loadInstanceQuotaCeiling(db),
    selfRegistrationDefaults: await loadSelfRegistrationQuotaDefaults(db),
  };
  const [instanceCeiling, selfRegistrationDefaults] = await Promise.all([
    saveInstanceQuotaCeiling(db, { monthlyBudgetUsd: parsed.data.instanceMonthlyBudgetUsd }),
    saveSelfRegistrationQuotaDefaults(db, {
      monthlyRunBudgetUsd: parsed.data.selfRegistrationMonthlyRunBudgetUsd,
      maxConcurrentRuns: parsed.data.selfRegistrationMaxConcurrentRuns,
    }),
  ]);
  await recordInstanceAudit(db, {
    key: 'spend_ceiling',
    actor: event.locals.user ?? null,
    before,
    after: { instanceCeiling, selfRegistrationDefaults },
  });
  return spendCeilingResponse();
}
