import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  campaigns,
  drafts,
  memberships,
  organizations,
  orgInvites,
  projects,
  runs,
  users,
} from './db/schema.js';
import { loadOrgQuotaDefaults, loadSelfRegistrationQuotaDefaults } from './org-quota.js';
import { isCloud } from './edition.js';
import { PLAN_CATALOGUE, type PlanId } from './plans.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export type OrgRole = 'owner' | 'admin' | 'member';

export type OrgInvite = typeof orgInvites.$inferSelect;

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

/**
 * Resolves a run's org and checks it matches `orgId`. Runs carry their
 * project either directly (`runs.projectId` - project_extraction,
 * project_insights, draft_regeneration, reply_drafting) or transitively via
 * their campaign (`runs.campaignId` -> campaigns.projectId - campaign,
 * campaign_skill_generation runs). `runs.campaignId` is nullable, so a plain
 * inner join through `campaigns` misses every non-campaign run kind; match on
 * either path instead.
 */
export async function runBelongsToOrg(db: Db, runId: number, orgId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .leftJoin(campaigns, eq(campaigns.id, runs.campaignId))
    .innerJoin(projects, or(eq(projects.id, runs.projectId), eq(projects.id, campaigns.projectId)))
    .where(and(eq(runs.id, runId), eq(projects.organizationId, orgId)))
    .limit(1);
  return !!row;
}

/**
 * Resolves a run's org id, or null if the run (or its project) does not
 * exist. Mirrors `runBelongsToOrg`'s join: a run carries its project either
 * directly (`runs.projectId`) or transitively via its campaign
 * (`runs.campaignId` -> campaigns.projectId). Used to tag realtime events
 * emitted from the runner with the owning org so they never cross tenants.
 */
export async function getRunOrgId(db: Db, runId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: projects.organizationId })
    .from(runs)
    .leftJoin(campaigns, eq(campaigns.id, runs.campaignId))
    .innerJoin(projects, or(eq(projects.id, runs.projectId), eq(projects.id, campaigns.projectId)))
    .where(eq(runs.id, runId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * Resolves a campaign's org id, or null if the campaign (or its project) does
 * not exist. Used by the MCP boundary (`cli/src/mcp/server.ts`) to resolve
 * the session's bound organization when the session carries a campaign id
 * but no run id yet (e.g. `run_start`, before the run row exists).
 */
export async function getCampaignOrgId(db: Db, campaignId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: projects.organizationId })
    .from(campaigns)
    .innerJoin(projects, eq(projects.id, campaigns.projectId))
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * Resolves a run's project id, or null if the run (or its project) does not
 * exist. Mirrors `getRunOrgId`'s join: a run carries its project either
 * directly (`runs.projectId`) or transitively via its campaign
 * (`runs.campaignId` -> campaigns.projectId). Used by the MCP boundary to
 * scope `drafts_get`'s list mode to the session's project instead of
 * scanning the whole `drafts` table.
 */
export async function getRunProjectId(db: Db, runId: number): Promise<number | null> {
  const [row] = await db
    .select({ projectId: projects.id })
    .from(runs)
    .leftJoin(campaigns, eq(campaigns.id, runs.campaignId))
    .innerJoin(projects, or(eq(projects.id, runs.projectId), eq(projects.id, campaigns.projectId)))
    .where(eq(runs.id, runId))
    .limit(1);
  return row?.projectId ?? null;
}

/**
 * Resolves a campaign's project id directly, or null if the campaign does
 * not exist. Used alongside `getRunProjectId` to resolve the MCP session's
 * bound project from whichever id (run or campaign) the session carries.
 */
export async function getCampaignProjectId(db: Db, campaignId: number): Promise<number | null> {
  const [row] = await db
    .select({ projectId: campaigns.projectId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return row?.projectId ?? null;
}

/**
 * Resolves a draft's org id (via drafts.projectId -> projects.organizationId),
 * or null if the draft does not exist. Used to tag realtime events emitted
 * from extension-authenticated routes (which have no `requireOrgId` context)
 * with the owning org.
 */
export async function getDraftOrgId(db: Db, draftId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: projects.organizationId })
    .from(drafts)
    .innerJoin(projects, eq(projects.id, drafts.projectId))
    .where(eq(drafts.id, draftId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * Same lookup, but for callers that cannot proceed without a tenant. Writing a
 * `contact_history` row is the case that matters: its `organization_id` is NOT
 * NULL (#263), so a null org means either the draft vanished under us or the
 * caller passed the wrong id. Both deserve a named error rather than the
 * column's opaque constraint violation.
 *
 * Null is unreachable for a draft that exists: `drafts.project_id` and
 * `projects.organization_id` are both NOT NULL, so the join always yields one.
 */
export async function requireDraftOrgId(db: Db, draftId: number): Promise<number> {
  const orgId = await getDraftOrgId(db, draftId);
  if (orgId == null) throw new Error(`draft ${draftId} has no resolvable organization`);
  return orgId;
}

/**
 * Resolves a project's org id directly, or null if the project does not
 * exist. Used by daemon loops (keyword watcher, scheduler) that hold a
 * project id but have no run/draft context to resolve the org through.
 */
export async function getProjectOrgId(db: Db, projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.orgId ?? null;
}

export async function listOrgMembers(db: Db, orgId: number) {
  return db
    .select({
      userId: memberships.userId,
      username: users.username,
      email: users.email,
      role: memberships.role,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, orgId))
    .orderBy(memberships.createdAt);
}

/** Invites for an org that have not been accepted and have not expired. */
export async function listPendingInvites(db: Db, orgId: number) {
  return db
    .select({
      token: orgInvites.token,
      role: orgInvites.role,
      email: orgInvites.email,
      expiresAt: orgInvites.expiresAt,
      createdAt: orgInvites.createdAt,
    })
    .from(orgInvites)
    .where(
      and(
        eq(orgInvites.organizationId, orgId),
        isNull(orgInvites.acceptedAt),
        gt(orgInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(orgInvites.createdAt));
}

/**
 * Delete a pending invite by token, scoped to the org (so one org cannot revoke
 * another org's invite). Returns true if an invite was actually removed.
 */
export async function revokeInvite(db: Db, orgId: number, token: string): Promise<boolean> {
  const rows = await db
    .delete(orgInvites)
    .where(
      and(
        eq(orgInvites.token, token),
        eq(orgInvites.organizationId, orgId),
        isNull(orgInvites.acceptedAt),
      ),
    )
    .returning({ token: orgInvites.token });
  return rows.length > 0;
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

export async function findValidInvite(db: Db, token: string): Promise<OrgInvite | null> {
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

export async function listUserOrganizations(
  db: Db,
  userId: number,
): Promise<{ id: number; slug: string; name: string; role: string }[]> {
  return db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.id);
}

export async function loadActiveOrganization(
  db: Db,
  userId: number,
  preferredOrgId?: number | null,
): Promise<{ id: number; slug: string; role: string } | null> {
  const rows = await db
    .select({ id: organizations.id, slug: organizations.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.id);
  if (rows.length === 0) return null;
  if (preferredOrgId != null) {
    const match = rows.find((r) => r.id === preferredOrgId);
    if (match) return match;
  }
  return rows[0];
}

/**
 * Creates an organization with an owner membership, its `personal` project,
 * and a starting run quota - the single primitive behind both a
 * self-registered account's own org (`POST /api/auth/register`'s no-invite
 * path, #513) and an existing user creating an additional org (`POST
 * /api/orgs`). Neither caller is an operator who has configured anything
 * for this org yet, so it must never start on `null` (unlimited) the way a
 * manually-provisioned org can. The seeded `default` org bypasses this
 * function entirely (inserted directly by createUser/seed-core) and keeps
 * its unlimited, unconfigured caps - it is the single-tenant self-host
 * fallback, not a self-created tenant.
 *
 * Two different sources for that starting budget/concurrency, and which one
 * applies depends on the edition (#544), not on `quotaSource`:
 *
 * - **Cloud**: every new org starts on the Free plan (`organizations.plan`
 *   keeps its column default of `'free'`/`'default'`), and Free's own
 *   `monthlyRunBudgetUsd`/`maxConcurrentRuns` (`shared/src/plans.ts`) are
 *   what land on the row - `quotaSource` is accepted but does not change the
 *   numbers, since a stranger and an invited tenant both land on the same
 *   plan until they pay or get a grant.
 * - **Self-host has no plans** (`resolveEntitlements` always returns
 *   unlimited there, so `organizations.plan` is never read): it keeps
 *   reading the `app_config` knobs an operator can edit without a redeploy,
 *   same as before this issue. `quotaSource` (#540) picks which one:
 *   `'invited'` (`org_quota_defaults`), what `POST /api/orgs` always passes
 *   implicitly (that caller already has an account on this instance, invited
 *   or not), or `'self_registration'` (`self_registration_quota_defaults`),
 *   passed only by the register route's no-invite branch - a separate, lower
 *   key so raising what an invited or paying tenant gets never also raises
 *   what a stranger who just typed an email into `/register` gets.
 */
export async function createOrganization(
  db: Db,
  args: {
    slug: string;
    name: string;
    ownerUserId: number;
    quotaSource?: 'invited' | 'self_registration';
  },
): Promise<{ id: number; slug: string; role: string }> {
  let monthlyRunBudgetUsd: number | null;
  let maxConcurrentRuns: number | null;
  if (isCloud()) {
    monthlyRunBudgetUsd = PLAN_CATALOGUE.free.monthlyRunBudgetUsd;
    maxConcurrentRuns = PLAN_CATALOGUE.free.maxConcurrentRuns;
  } else {
    const quotaDefaults =
      args.quotaSource === 'self_registration'
        ? await loadSelfRegistrationQuotaDefaults(db)
        : await loadOrgQuotaDefaults(db);
    monthlyRunBudgetUsd = quotaDefaults.monthlyRunBudgetUsd;
    maxConcurrentRuns = quotaDefaults.maxConcurrentRuns;
  }
  const [org] = await db
    .insert(organizations)
    .values({
      slug: args.slug,
      name: args.name,
      monthlyRunBudgetUsd: monthlyRunBudgetUsd == null ? null : monthlyRunBudgetUsd.toFixed(2),
      maxConcurrentRuns,
    })
    .returning();
  await db
    .insert(memberships)
    .values({ organizationId: org.id, userId: args.ownerUserId, role: 'owner' })
    .onConflictDoNothing();
  // #523: a fresh organization gets no project it did not ask for. Until
  // 2026-09-09 this created a `personal` project up front so a suggestion
  // not about a product had somewhere to file; the assist plane now binds
  // to the operator and its own ledger directly (shared/src/assist-accept.ts)
  // and a project is optional context there, so there is nothing left for
  // this org to need one for at creation time.
  return { id: org.id, slug: org.slug, role: 'owner' };
}

/**
 * Sets an organization's plan (#544) - the only writer of
 * `organizations.plan`/`plan_source`/`plan_updated_at` outside the Stripe
 * webhook (#551, not built here, which is expected to call this with
 * `source: 'stripe'`). `source: 'grant'` is what an instance-admin grant
 * route (gated by `requireInstanceAdmin`, not an org's own admin) uses - my
 * own org, a client's org, a friend's org, all stop being billing problems
 * this way. Syncs `monthly_run_budget_usd`/`max_concurrent_runs` from the
 * new plan's own numbers in the same update, so the existing dispatch checks
 * (`getOrgQuotaSnapshot`, `assertOrgConcurrencyAdmitted` in
 * `shared/src/org-quota.ts`) keep enforcing the right ceiling without
 * themselves knowing plans exist - see `resolveEntitlements`
 * (`shared/src/plans.ts`) for why a grant then outranks whatever a
 * subscription mirrors for the same org. Returns true if a row was updated,
 * false if the org does not exist.
 */
export async function setOrgPlan(
  db: Db,
  orgId: number,
  planId: PlanId,
  source: 'grant' | 'stripe',
): Promise<boolean> {
  const plan = PLAN_CATALOGUE[planId];
  const rows = await db
    .update(organizations)
    .set({
      plan: planId,
      planSource: source,
      planUpdatedAt: new Date(),
      monthlyRunBudgetUsd:
        plan.monthlyRunBudgetUsd == null ? null : plan.monthlyRunBudgetUsd.toFixed(2),
      maxConcurrentRuns: plan.maxConcurrentRuns,
    })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });
  return rows.length > 0;
}

/**
 * Derives an available organization slug from a username, for the register
 * route's no-invite path (open sign-up, #505). Settled by #513: the
 * username is what open registration already collects and already needs to
 * be unique-ish for login, so the slug rides on it rather than the email
 * local part, which the registrant did not choose and may well share with
 * a colleague's shared inbox alias. Collision-suffixed with a numeric
 * counter against `organizations.slug`'s unique constraint, since the
 * person was never asked to pick a slug of their own.
 */
export async function uniqueOrgSlugFromUsername(db: Db, username: string): Promise<string> {
  const base =
    username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 54) || 'org';
  let candidate = base;
  let suffix = 2;
  while (await findOrgBySlug(db, candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** The role of a user in an org, or null if they are not a member. */
export async function getMemberRole(db: Db, orgId: number, userId: number): Promise<string | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** How many owners the org currently has (used to protect the last owner). */
export async function countOrgOwners(db: Db, orgId: number): Promise<number> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.role, 'owner')));
  return rows.length;
}

/** Update a member's role. Returns true if a membership row was changed. */
export async function setMemberRole(
  db: Db,
  orgId: number,
  userId: number,
  role: OrgRole,
): Promise<boolean> {
  const rows = await db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId });
  return rows.length > 0;
}

/** Remove a member from an org. Returns true if a membership row was removed. */
export async function removeMember(db: Db, orgId: number, userId: number): Promise<boolean> {
  const rows = await db
    .delete(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId });
  return rows.length > 0;
}

/** Friendly default org name derived from a username or email (local part). */
export function defaultOrgName(username: string): string {
  const local = username.includes('@') ? username.split('@')[0] : username;
  const clean = local.trim() || 'My';
  return `${clean}'s Organization`;
}

/** Rename an org. Returns true if a row was updated. */
export async function renameOrg(db: Db, orgId: number, name: string): Promise<boolean> {
  const rows = await db
    .update(organizations)
    .set({ name })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });
  return rows.length > 0;
}

/**
 * Delete an org row. FK cascades wipe its projects/campaigns/drafts/memberships/
 * invites. Returns true if a row was removed. The caller must refuse the
 * `default` org (it is the auth-off fallback) and gate this to owners.
 */
export async function deleteOrganization(db: Db, orgId: number): Promise<boolean> {
  const rows = await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });
  return rows.length > 0;
}
