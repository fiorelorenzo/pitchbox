import { eq } from 'drizzle-orm';
import { error, type RequestEvent } from '@sveltejs/kit';
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

/**
 * Resolve the active organization id or fail the request. Use this at the top of
 * every route that reads or mutates tenant-scoped data. With auth off it returns
 * the default org, preserving single-tenant self-host behaviour.
 */
export async function requireOrgId(event: RequestEvent): Promise<number> {
  const orgId = await resolveOrgId(event);
  if (orgId == null) throw error(404, 'not_found');
  return orgId;
}

const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };

/**
 * Require the active-org role to rank at least `minRole`, else throw 403. A
 * no-op when auth is off (no `locals.org`), so single-user self-host keeps full
 * access. Call after the tenant guards (`requireOrgId` + `*BelongsToOrg`).
 */
export function requireRole(event: RequestEvent, minRole: 'member' | 'admin' | 'owner'): void {
  const role = event.locals.org?.role;
  if (!role) return; // auth off / no org context -> self-host, full access
  if ((ROLE_RANK[role] ?? 0) < ROLE_RANK[minRole]) {
    throw error(403, 'forbidden');
  }
}

/**
 * Require the signed-in user to be the instance admin, else throw 403. This
 * is a separate concept from the per-org 'admin' role: any user can
 * self-create an org via POST /api/orgs and become its owner/admin, but that
 * must not grant access to instance-wide config (default runner, quota
 * defaults, webhook config) shared by every tenant. A no-op when auth is off
 * (no `locals.user`), so single-user self-host keeps full access, same
 * convention as `requireRole`.
 */
export async function requireInstanceAdmin(event: RequestEvent): Promise<void> {
  const user = event.locals.user;
  if (!user) return; // auth off -> self-host, full access
  const db = getDb();
  const [row] = await db
    .select({ isInstanceAdmin: schema.users.isInstanceAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (!row?.isInstanceAdmin) {
    throw error(403, 'forbidden');
  }
}
