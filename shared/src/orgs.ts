import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  campaigns,
  drafts,
  memberships,
  organizations,
  orgInvites,
  projects,
  runs,
} from './db/schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export type OrgRole = 'owner' | 'admin' | 'member';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Returns true if `projectId` belongs to `orgId`. Used by every route that
 * mutates project-scoped resources (drafts, runs, accounts, campaigns) to
 * prevent cross-tenant access. Returns 404 on miss is the caller's job.
 */
export async function projectBelongsToOrg(
  db: Db,
  projectId: number,
  orgId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)))
    .limit(1);
  return !!row;
}

export async function campaignBelongsToOrg(
  db: Db,
  campaignId: number,
  orgId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .innerJoin(projects, eq(projects.id, campaigns.projectId))
    .where(and(eq(campaigns.id, campaignId), eq(projects.organizationId, orgId)))
    .limit(1);
  return !!row;
}

export async function draftBelongsToOrg(db: Db, draftId: number, orgId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .innerJoin(projects, eq(projects.id, drafts.projectId))
    .where(and(eq(drafts.id, draftId), eq(projects.organizationId, orgId)))
    .limit(1);
  return !!row;
}

export async function runBelongsToOrg(db: Db, runId: number, orgId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(campaigns, eq(campaigns.id, runs.campaignId))
    .innerJoin(projects, eq(projects.id, campaigns.projectId))
    .where(and(eq(runs.id, runId), eq(projects.organizationId, orgId)))
    .limit(1);
  return !!row;
}

export async function listOrgMembers(db: Db, orgId: number) {
  return db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .where(eq(memberships.organizationId, orgId));
}

export async function isOrgAdmin(db: Db, userId: number, orgId: number): Promise<boolean> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, orgId)))
    .limit(1);
  if (!row) return false;
  return row.role === 'owner' || row.role === 'admin';
}

export async function createInvite(
  db: Db,
  args: {
    organizationId: number;
    role?: OrgRole;
    email?: string | null;
    createdByUserId: number;
  },
): Promise<{ id: number; token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(orgInvites)
    .values({
      organizationId: args.organizationId,
      token,
      email: args.email ?? null,
      role: args.role ?? 'member',
      expiresAt,
      createdByUserId: args.createdByUserId,
    })
    .returning({ id: orgInvites.id });
  return { id: row.id, token, expiresAt };
}

export async function findValidInvite(db: Db, token: string) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(orgInvites)
    .where(
      and(
        eq(orgInvites.token, token),
        isNull(orgInvites.acceptedAt),
        gt(orgInvites.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function acceptInvite(
  db: Db,
  token: string,
  userId: number,
): Promise<{ organizationId: number; role: string } | null> {
  const invite = await findValidInvite(db, token);
  if (!invite) return null;
  await db
    .insert(memberships)
    .values({ organizationId: invite.organizationId, userId, role: invite.role })
    .onConflictDoNothing();
  await db.update(orgInvites).set({ acceptedAt: new Date() }).where(eq(orgInvites.id, invite.id));
  return { organizationId: invite.organizationId, role: invite.role };
}

export async function findOrgBySlug(db: Db, slug: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return row ?? null;
}
