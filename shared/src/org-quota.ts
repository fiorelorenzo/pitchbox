// Per-org cloud-runner quota (CLD-P5, docs/cloud-runner-productionization-design.md
// section 5). Computes the control-plane's snapshot of an org's remaining
// monthly USD run budget and its concurrency cap, minted into the runner JWT's
// `quota` claim (shared/src/agents/cloud/jwt.ts) at dispatch time. Mirrors the
// per-account quota helper's style (shared/src/quota.ts) but is org-scoped and
// budget/concurrency based rather than per-account daily/weekly counts.
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import type { RunnerJwtQuota } from './agents/cloud/protocol.js';

export type { RunnerJwtQuota };

/** First instant (UTC) of the calendar month containing `now`. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Sum of `runs.cost_usd` for every run belonging to `orgId`, started on or
 * after the first of the current calendar month (UTC). Mirrors the
 * project-or-campaign join `getRunOrgId`/`runBelongsToOrg` use
 * (shared/src/orgs.ts) since `runs` carries its project either directly or
 * transitively via `campaigns`. Runs with a null `cost_usd` (no usage
 * reported) contribute 0.
 */
export async function getOrgMonthToDateCostUsd(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<number> {
  const monthStart = startOfMonthUtc(now);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)` })
    .from(schema.runs)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
    .innerJoin(
      schema.projects,
      or(
        eq(schema.projects.id, schema.runs.projectId),
        eq(schema.projects.id, schema.campaigns.projectId),
      ),
    )
    .where(and(eq(schema.projects.organizationId, orgId), gte(schema.runs.startedAt, monthStart)));
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
