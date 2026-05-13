import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { loadOrganizationForUser } from '@pitchbox/shared/auth';
import { getDb, schema } from './db.js';

/**
 * Resolve the organization id for the current request.
 *
 * - When auth is on and the caller is signed in, return their primary org
 *   (we ship a single membership per user - multi-org follows later).
 * - When auth is off (single-user self-host) or no membership exists yet,
 *   fall back to the default org seeded by `seed-core`.
 *
 * Returns null only if neither the user nor the default org can be located,
 * which shouldn't happen on a migrated install.
 */
export async function resolveOrgId(event: RequestEvent): Promise<number | null> {
  // Prefer the org already resolved by the hook (avoids a second DB roundtrip).
  if (event.locals.org) return event.locals.org.id;
  const db = getDb();
  const user = event.locals.user;
  if (user) {
    const org = await loadOrganizationForUser(db, user.id);
    if (org) return org.id;
  }
  const [row] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'))
    .limit(1);
  return row?.id ?? null;
}
