import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema, type Db } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';
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

async function resolveDeviceOrgId(db: Db, organizationId: number | null): Promise<number | null> {
  if (organizationId != null) return organizationId;
  // A null-org device only happens on self-host / auth-off pairing paths
  // that predate #196's fail-loud fix. Fall back to the default org, the
  // same resolution auto-pair itself uses in that mode.
  const [row] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'))
    .limit(1);
  return row?.id ?? null;
}

export async function GET({ request }: { request: Request }) {
  const auth = await requireExtensionAuth(request);
  if (!perDevice.consume(`device:${auth.deviceId}`)) throw error(429, 'too many requests');

  const db = getDb();
  const orgId = await resolveDeviceOrgId(db, auth.organizationId);
  if (orgId == null) throw error(404, 'not_found');

  const assist = await loadLinkedInAssistDeviceState(db, orgId);
  return json({ assist });
}
