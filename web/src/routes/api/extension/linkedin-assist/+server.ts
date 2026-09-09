import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { loadLinkedInAssistDeviceState } from '@pitchbox/shared/linkedin-assist';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';
import { getOrgUsage } from '@pitchbox/shared/usage';
import { isOrgReadOnly, PLAN_CATALOGUE } from '@pitchbox/shared/plans';

// The read path #302's collector and #314's panel poll to learn whether they
// should be running at all and which project a suggestion writes as (LI-19,
// #316). No auth story of its own: it reuses the device bearer token every
// other /api/extension/* route already requires. There is no cache between
// this route and app_config, so a flipped kill switch is visible on the very
// next poll - "a kill switch that takes ten minutes to apply is not a kill
// switch" (docs/linkedin-integration-design.md).
//
// Response shape (see PR body for the frozen contract):
//   { assist: LinkedInAssistDeviceState, plan: LinkedInAssistPlanState }
// LinkedInAssistDeviceState (shared/src/linkedin-assist.ts) carries booleans,
// the bound project id, the org's `personal` project id (2026-09-07 - where
// an accepted suggestion files when it is not about a product) and the two
// daily caps - nothing org-scoped beyond what the device already handles in
// observations/suggest bodies. `plan` is #556: the panel and the side panel
// need the plan's name, the suggestion allowance and how much of it is left,
// and whether the org is read-only, purely for display - extending this
// endpoint rather than adding a second poll. Anything cached from it is a
// hint: `/suggest` refuses on its own read of the same numbers regardless of
// what a stale poll here still shows.

// Polled on an interval by a background script, not user-driven, so this is
// tighter than /suggest's perDevice(20, 60_000) while still generous for any
// reasonable poll cadence.
const perDevice = new RateLimiter(12, 60_000);

export async function GET({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many requests');

  const db = getDb();
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'not_found');

  const assist = await loadLinkedInAssistDeviceState(db, orgId);
  const period = await billingPeriodFor(db, orgId);
  const usage = await getOrgUsage(db, orgId, period);
  const plan = {
    id: usage.entitlements.planId,
    name: PLAN_CATALOGUE[usage.entitlements.planId].name,
    suggestionsUsed: usage.suggestions.used,
    suggestionsLimit: usage.suggestions.limit,
    suggestionsRemaining: usage.suggestions.remaining,
    readOnly: isOrgReadOnly(usage.entitlements),
  };
  return json({ assist, plan });
}
