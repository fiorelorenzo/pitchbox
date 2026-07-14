import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../lib/server/db.js';
import { resolveOrgId } from '../../../lib/server/auth.js';
import { listOrgMembers, listPendingInvites } from '@pitchbox/shared/orgs';

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
    };
  }
  const [org] = await db
    .select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));

  const role = event.locals.org?.role ?? null;
  const canManage = role === 'owner' || role === 'admin';
  const members = await listOrgMembers(db, orgId);
  const invites = canManage ? await listPendingInvites(db, orgId) : [];

  return {
    org: org ?? null,
    role,
    canManage,
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
  };
};
