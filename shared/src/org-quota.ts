// Per-org cloud-runner quota (CLD-P5, docs/cloud-runner-productionization-design.md
// section 5). Computes the control-plane's snapshot of an org's remaining
// monthly USD run budget and its concurrency cap, minted into the runner JWT's
// `quota` claim (shared/src/agents/cloud/jwt.ts) at dispatch time. Mirrors the
// per-account quota helper's style (shared/src/quota.ts) but is org-scoped and
// budget/concurrency based rather than per-account daily/weekly counts.
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import type { RunnerJwtQuota } from './agents/cloud/protocol.js';

export type { RunnerJwtQuota };

/** First instant (UTC) of the calendar month containing `now`. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Sum of `runs.cost_usd` for every run belonging to `orgId`, started on or
 * after the first of the current calendar month (UTC). Runs with a null
 * `cost_usd` (no usage reported) contribute 0.
 *
 * Resolves the org's project ids first, then matches runs against them
 * directly (`runs.projectId`) or transitively via their campaign
 * (`runs.campaignId` -> `campaigns.projectId`), mirroring the dashboard's
 * spend widget (web/src/routes/+page.server.ts, the `runOrgMatch` /
 * `spendRow` query). This deliberately never joins the `projects` table
 * itself: an `innerJoin(projects, or(eq(projects.id, runs.projectId),
 * eq(projects.id, campaigns.projectId)))` (as `getRunOrgId`/`runBelongsToOrg`
 * in shared/src/orgs.ts use for single-row lookups) can match two distinct
 * project rows for one run whenever `runs.projectId` and
 * `campaigns.projectId` disagree, which would double-count that run's cost
 * in this un-grouped SUM and could falsely trip `quota_exceeded`. Filtering
 * by project id membership instead of joining the table keeps each run a
 * single row regardless of how many of its project references resolve.
 */
export async function getOrgMonthToDateCostUsd(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<number> {
  const monthStart = startOfMonthUtc(now);

  const orgProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, orgId));
  const projectIds = orgProjects.map((p) => p.id);
  // `inArray(x, [])` is a SQL error, and an org with no projects has no runs
  // to sum anyway.
  if (projectIds.length === 0) {
    return 0;
  }

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)` })
    .from(schema.runs)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
    .where(
      and(
        or(
          inArray(schema.runs.projectId, projectIds),
          inArray(schema.campaigns.projectId, projectIds),
        ),
        gte(schema.runs.startedAt, monthStart),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Compute an org's quota snapshot at mint time: remaining monthly USD budget
 * (null = unlimited, since `organizations.monthly_run_budget_usd` is null) and
 * its concurrency cap (null = unlimited, `organizations.max_concurrent_runs`
 * null). A `remainingUsd` of 0 or negative means the org is over budget; the
 * runner rejects `session.start` for it (CLD-P5 admission). An org that no
 * longer exists (deleted between resolving the run and minting) is treated as
 * unlimited on both axes - not the runner's decision to make from a signed
 * claim it cannot re-check; the org lookup elsewhere in the dispatch path is
 * what actually gates a run against a missing org.
 */
export async function getOrgQuotaSnapshot(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<RunnerJwtQuota> {
  const [org] = await db
    .select({
      monthlyRunBudgetUsd: schema.organizations.monthlyRunBudgetUsd,
      maxConcurrentRuns: schema.organizations.maxConcurrentRuns,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);

  const concurrencyCap = org?.maxConcurrentRuns ?? null;
  if (!org || org.monthlyRunBudgetUsd == null) {
    return { remainingUsd: null, concurrencyCap };
  }

  const spentUsd = await getOrgMonthToDateCostUsd(db, orgId, now);
  const budgetUsd = Number(org.monthlyRunBudgetUsd);
  return { remainingUsd: budgetUsd - spentUsd, concurrencyCap };
}

export type OrgQuotaFields = {
  /** null = unlimited. */
  monthlyRunBudgetUsd: number | null;
  /** null = unlimited. */
  maxConcurrentRuns: number | null;
};

/**
 * Read the raw `monthly_run_budget_usd` / `max_concurrent_runs` columns for an
 * org (the org-quota settings UI, #161). Backs the GET side of
 * `/api/settings/org-quota`; unlike `getOrgQuotaSnapshot` this returns the
 * configured budget itself rather than the remaining amount, so the UI can
 * show what an operator last set. Returns null if the org does not exist.
 */
export async function getOrgQuotaFields(db: Db, orgId: number): Promise<OrgQuotaFields | null> {
  const [org] = await db
    .select({
      monthlyRunBudgetUsd: schema.organizations.monthlyRunBudgetUsd,
      maxConcurrentRuns: schema.organizations.maxConcurrentRuns,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  if (!org) return null;
  return {
    monthlyRunBudgetUsd: org.monthlyRunBudgetUsd == null ? null : Number(org.monthlyRunBudgetUsd),
    maxConcurrentRuns: org.maxConcurrentRuns,
  };
}

/**
 * Persist an org's budget + concurrency cap (#161). A pure write: callers
 * (the API route) are responsible for validating the incoming numbers
 * (non-negative or null) before calling this. Returns true if a row was
 * updated, false if the org does not exist.
 */
export async function setOrgQuota(db: Db, orgId: number, fields: OrgQuotaFields): Promise<boolean> {
  const rows = await db
    .update(schema.organizations)
    .set({
      monthlyRunBudgetUsd:
        fields.monthlyRunBudgetUsd == null ? null : fields.monthlyRunBudgetUsd.toFixed(2),
      maxConcurrentRuns: fields.maxConcurrentRuns,
    })
    .where(eq(schema.organizations.id, orgId))
    .returning({ id: schema.organizations.id });
  return rows.length > 0;
}
