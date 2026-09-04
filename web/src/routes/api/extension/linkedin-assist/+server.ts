import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db.js';
import { requireExtensionAuth, resolveDeviceOrgId } from '$lib/server/extension-auth.js';
import { RateLimiter } from '$lib/server/rate-limit.js';
import { loadLinkedInAssistDeviceState } from '@pitchbox/shared/linkedin-assist';

// The read path #302's collector and #314's panel poll to learn whether they
// should be running at all and which project a suggestion writes as (LI-19,
// #316). No auth story of its own: it reuses the device bearer token every
// other /api/extension/* route already requires. There is no cache between
// this route and app_config, so a flipped kill switch is visible on the very
// next poll - "a kill switch that takes ten minutes to apply is not a kill
// switch" (docs/linkedin-integration-design.md).
//
// Response shape (see PR body for the frozen contract):
//   { assist: LinkedInAssistDeviceState }
// LinkedInAssistDeviceState (shared/src/linkedin-assist.ts) carries only
// booleans, the bound project id and the two daily caps - nothing org-scoped
// beyond what the device already handles in observations/suggest bodies.

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
  return json({ assist });
}
