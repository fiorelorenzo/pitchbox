import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { requireInstanceAdmin } from '$lib/server/auth.js';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { PLAN_IDS } from '@pitchbox/shared/plans';
import { getOrgPlanState, revokeOrgPlanGrant, setOrgPlan } from '@pitchbox/shared/orgs';

// Instance-admin plan grants (#187): my own org, and any other org, ended up
// on a Stripe-less `plan_source = 'grant'` (0027_org_plans.sql) with no route
// off it besides hand-written SQL. `setOrgPlan` (shared/src/orgs.ts) was
// already the only writer of `organizations.plan`/`plan_source` outside the
// Stripe webhook; this is the second caller the webhook's own comment
// anticipated. Gated by `requireInstanceAdmin`, same as every other write on
// this rail - a grant is an operator decision, never a per-org 'admin'/
// 'owner' one.

const GrantBody = z.object({
  orgId: z.number().int().positive(),
  planId: z.enum(PLAN_IDS),
  /**
   * Recorded in the audit row, not on the org itself: `organizations` has no
   * column for it. A blank reason defeats the point of the audit trail (a
   * grant row that only says "the plan changed" tells a later reader nothing
   * about why it does not match Stripe), so it is required.
   */
  reason: z.string().trim().min(1).max(2000),
});

const RevokeBody = z.object({
  orgId: z.number().int().positive(),
});

export async function POST(event: RequestEvent) {
  await requireInstanceAdmin(event);
  const parsed = GrantBody.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
  const { orgId, planId, reason } = parsed.data;

  const db = getDb();
  const before = await getOrgPlanState(db, orgId);
  if (!before) throw error(404, 'organization not found');

  await setOrgPlan(db, orgId, planId, 'grant');
  await recordInstanceAudit(db, {
    key: `org_plan_grant:${orgId}`,
    actor: event.locals.user ?? null,
    before,
    after: { plan: planId, planSource: 'grant', reason },
  });
  return json({ ok: true, plan: planId, planSource: 'grant' });
}

export async function DELETE(event: RequestEvent) {
  await requireInstanceAdmin(event);
  const parsed = RevokeBody.safeParse(await event.request.json().catch(() => null));
  if (!parsed.success) throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');

  const db = getDb();
  const result = await revokeOrgPlanGrant(db, parsed.data.orgId);
  if (!result.ok) {
    throw error(result.reason === 'not_found' ? 404 : 400, result.reason);
  }
  await recordInstanceAudit(db, {
    key: `org_plan_grant:${parsed.data.orgId}`,
    actor: event.locals.user ?? null,
    before: result.before,
    after: result.after,
  });
  return json({ ok: true, plan: result.after.plan, planSource: result.after.planSource });
}
