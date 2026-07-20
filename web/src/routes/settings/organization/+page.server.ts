import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../lib/server/db.js';
import { resolveOrgId } from '../../../lib/server/auth.js';
import { listOrgMembers, listPendingInvites } from '@pitchbox/shared/orgs';
import { getOrgMonthToDateCostUsd, getOrgQuotaSnapshot } from '@pitchbox/shared/org-quota';

export const load: PageServerLoad = async (event) => {
  const db = getDb();
  const orgId = await resolveOrgId(event);
  if (orgId == null) {
    return {
      org: null,
      role: null,
      canManage: false,
      currentUserId: null,
      members: [],
      invites: [],
      quota: null,
    };
  }
  const [org] = await db
    .select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
      monthlyRunBudgetUsd: schema.organizations.monthlyRunBudgetUsd,
      maxConcurrentRuns: schema.organizations.maxConcurrentRuns,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));

  const role = event.locals.org?.role ?? null;
  const canManage = role === 'owner' || role === 'admin';
  const members = await listOrgMembers(db, orgId);
  const invites = canManage ? await listPendingInvites(db, orgId) : [];

  // The quota card is admin+ only (matches the org-quota API route's
  // requireRole('admin') gate), so skip the extra queries for a member whose
  // UI hides the card anyway.
  let quota: {
    monthlyRunBudgetUsd: number | null;
    maxConcurrentRuns: number | null;
    monthToDateCostUsd: number;
    remainingUsd: number | null;
  } | null = null;
  if (canManage && org) {
    const [monthToDateCostUsd, snapshot] = await Promise.all([
      getOrgMonthToDateCostUsd(db, orgId),
      getOrgQuotaSnapshot(db, orgId),
    ]);
    quota = {
      monthlyRunBudgetUsd: org.monthlyRunBudgetUsd == null ? null : Number(org.monthlyRunBudgetUsd),
      maxConcurrentRuns: org.maxConcurrentRuns,
      monthToDateCostUsd,
      remainingUsd: snapshot.remainingUsd,
    };
  }

  return {
    org: org ? { id: org.id, slug: org.slug, name: org.name } : null,
    role,
    canManage,
    isOwner: role === 'owner',
    currentUserId: event.locals.user?.id ?? null,
    members: members.map((m) => ({
      userId: m.userId,
      username: m.username,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    })),
    invites: invites.map((i) => ({
      token: i.token,
      role: i.role,
      email: i.email,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    })),
    quota,
  };
};
