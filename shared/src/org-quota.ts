// Per-org run quota. Computes an org's remaining monthly USD run budget and
// its concurrency cap, enforced before a run starts and while it streams
// (shared/src/agents/sdk/runner.ts, web/src/lib/server/runner.ts). Mirrors the
// per-account quota helper's style (shared/src/quota.ts) but is org-scoped and
// budget/concurrency based rather than per-account daily/weekly counts.
import { and, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { schema, type Db } from './db/client.js';

// The loose handle personal-project.ts documents and orgs.ts already uses,
// rather than the strict `Db` above: loadOrgQuotaDefaults is called from
// createOrganization (shared/src/orgs.ts), which may be holding a
// transaction handle mid-registration, and the strict schema-bound type
// rejects that handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = PgDatabase<any, any, any>;

/**
 * An org's quota snapshot: remaining monthly USD run budget and concurrency
 * cap. Both fields are independently nullable: `null` means unlimited on that
 * axis (no budget cap / no concurrency cap).
 */
export interface OrgQuotaSnapshot {
  /** Org's remaining monthly USD run budget, or null if the org has no
   * configured budget (unlimited). A value <= 0 means the org is over budget. */
  remainingUsd: number | null;
  /** Max concurrent runs allowed for this org, or null if unlimited. */
  concurrencyCap: number | null;
}

/**
 * The default budget/concurrency an org gets at creation when nobody has
 * configured one - #515: null on `organizations.monthly_run_budget_usd` /
 * `max_concurrent_runs` means unlimited, and a self-created org (open
 * registration, or an existing user spinning up an additional org via
 * `POST /api/orgs`) must never start there. Read from `app_config` next to
 * `quota_defaults` so an operator can change the numbers without a
 * redeploy; seeded by seed-core.ts alongside `quota_defaults`.
 */
export type OrgQuotaDefaults = {
  monthlyRunBudgetUsd: number;
  maxConcurrentRuns: number;
};

const ORG_QUOTA_DEFAULTS_KEY = 'org_quota_defaults';

// Used both as the seed-core.ts value and as the fallback when the
// app_config row is missing entirely (a fresh install that ran migrations
// but not seed:core) or holds something malformed. Numbers are deliberately
// modest: enough for a real evaluation of the product in a month, not
// enough to run up a meaningful Gateway bill on an account nobody vetted.
export const ORG_QUOTA_DEFAULTS_FALLBACK: OrgQuotaDefaults = {
  monthlyRunBudgetUsd: 20,
  maxConcurrentRuns: 2,
};

export async function loadOrgQuotaDefaults(db: AnyDb): Promise<OrgQuotaDefaults> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, ORG_QUOTA_DEFAULTS_KEY))
    .limit(1);
  const value = row?.value as Partial<Record<string, unknown>> | undefined;
  const budget = Number(value?.monthlyRunBudgetUsd);
  const concurrency = Number(value?.maxConcurrentRuns);
  return {
    monthlyRunBudgetUsd:
      Number.isFinite(budget) && budget > 0
        ? budget
        : ORG_QUOTA_DEFAULTS_FALLBACK.monthlyRunBudgetUsd,
    maxConcurrentRuns:
      Number.isFinite(concurrency) && concurrency > 0
        ? Math.floor(concurrency)
        : ORG_QUOTA_DEFAULTS_FALLBACK.maxConcurrentRuns,
  };
}

/** First instant (UTC) of the calendar month containing `now`. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Org month-to-date spend, split into campaign/other-run cost and assistant
 * (in-page suggestion) cost, both started/created on or after the first of
 * the current calendar month (UTC). #522: the assistant plane writes no
 * `runs` row for a suggestion (see web/src/routes/api/extension/suggest -
 * a suggestion is ephemeral until a human accepts it), so its spend lives in
 * `assist_usage` instead, one row per finished suggestion whether accepted
 * or not. Kept apart rather than pre-summed, per #522's decision: an
 * operator asking "why am I out of budget" needs to see which half spent it
 * (`getOrgMonthToDateCostUsd` below still returns the single number a
 * budget decision needs).
 *
 * The `runs` side deliberately excludes `kind = 'assist'`: accepting a
 * suggestion (shared/src/assist-accept.ts) still writes a `runs` row so the
 * draft has somewhere to hang off `run_id`, but that row's own `cost_usd` is
 * always null now - the suggestion's cost was already ledgered here the
 * moment its stream finished, and summing both would count an accepted
 * suggestion twice (once here, once there).
 *
 * The `runs` query resolves the org's project ids first, then matches runs
 * against them directly (`runs.projectId`) or transitively via their
 * campaign (`runs.campaignId` -> `campaigns.projectId`), mirroring the
 * dashboard's spend widget (web/src/routes/+page.server.ts, the
 * `runOrgMatch` / `spendRow` query). This deliberately never joins the
 * `projects` table itself: an `innerJoin(projects, or(eq(projects.id,
 * runs.projectId), eq(projects.id, campaigns.projectId)))` (as
 * `getRunOrgId`/`runBelongsToOrg` in shared/src/orgs.ts use for single-row
 * lookups) can match two distinct project rows for one run whenever
 * `runs.projectId` and `campaigns.projectId` disagree, which would
 * double-count that run's cost in this un-grouped SUM and could falsely trip
 * `quota_exceeded`. Filtering by project id membership instead of joining
 * the table keeps each run a single row regardless of how many of its
 * project references resolve. `assist_usage` carries its own `projectId`
 * directly (a suggestion is always grounded in one project, never a
 * campaign), so its side needs no such join at all.
 */
export interface OrgMonthToDateSpend {
  campaignUsd: number;
  assistantUsd: number;
  totalUsd: number;
}

export async function getOrgMonthToDateSpend(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<OrgMonthToDateSpend> {
  const monthStart = startOfMonthUtc(now);

  const orgProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, orgId));
  const projectIds = orgProjects.map((p) => p.id);
  // `inArray(x, [])` is a SQL error, and an org with no projects has no runs
  // or assist usage to sum anyway.
  if (projectIds.length === 0) {
    return { campaignUsd: 0, assistantUsd: 0, totalUsd: 0 };
  }

  const [runRow] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)` })
    .from(schema.runs)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
    .where(
      and(
        ne(schema.runs.kind, 'assist'),
        or(
          inArray(schema.runs.projectId, projectIds),
          inArray(schema.campaigns.projectId, projectIds),
        ),
        gte(schema.runs.startedAt, monthStart),
      ),
    );

  const [assistRow] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.assistUsage.costUsd}), 0)` })
    .from(schema.assistUsage)
    .where(
      and(
        inArray(schema.assistUsage.projectId, projectIds),
        gte(schema.assistUsage.createdAt, monthStart),
      ),
    );

  const campaignUsd = Number(runRow?.total ?? 0);
  const assistantUsd = Number(assistRow?.total ?? 0);
  return { campaignUsd, assistantUsd, totalUsd: campaignUsd + assistantUsd };
}

/**
 * The single number a budget decision uses (org-quota's own gate in
 * getOrgQuotaSnapshot, the instance-wide ceiling): campaign spend plus
 * assistant spend, month-to-date. See getOrgMonthToDateSpend for the split
 * and why the two are kept apart for a human but combined here for a cap.
 */
export async function getOrgMonthToDateCostUsd(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<number> {
  const { totalUsd } = await getOrgMonthToDateSpend(db, orgId, now);
  return totalUsd;
}

/**
 * Compute an org's current quota snapshot: remaining monthly USD budget (null
 * = unlimited, since `organizations.monthly_run_budget_usd` is null) and its
 * concurrency cap (null = unlimited, `organizations.max_concurrent_runs`
 * null). A `remainingUsd` of 0 or negative means the org is over budget. An
 * org that no longer exists is treated as unlimited on both axes - not this
 * function's decision to make; the org lookup elsewhere in the dispatch path
 * is what actually gates a run against a missing org.
 */
export async function getOrgQuotaSnapshot(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<OrgQuotaSnapshot> {
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

/**
 * Admit-or-refuse a single already-inserted `runs` row against
 * `organizations.max_concurrent_runs` (#485). The old runner service
 * enforced this from an in-memory per-org session map that disappeared
 * with the service itself (#420); nothing replaced it, so an org could
 * start as many simultaneous cloud runs as it could trigger.
 *
 * Every dispatch path (`web/src/lib/server/runner.ts`) inserts its `runs`
 * row with `status: 'running'` before calling `dispatchRun`, so by the time
 * this runs the caller's own row already counts itself - a plain
 * `count > cap` after the fact would only ever refuse, never decide which
 * of two racing dispatches gets the free slot, and a plain count taken
 * *before* either insert is visible to the other is exactly the TOCTOU gap
 * #485 reported (both readers see themselves as first). Both are closed by
 * `pg_advisory_xact_lock` keyed on the org, the same primitive
 * `withCampaignLock` (shared/src/scheduler/dispatch-lock.ts) already uses
 * for the sibling per-campaign race: it forces every concurrent admission
 * decision for one org through a single line, so whichever one runs the
 * ranking query below always sees a fully-committed, stable view. Once
 * inside the lock, every currently `running` row for the org is ranked by
 * `id` (insertion order) and this run is admitted iff its own rank is
 * within the cap - so of N runs racing for the org's free slots, exactly
 * as many as the cap allows win, not "however many happened to look small"
 * and not "all of them, because nobody's insert was visible to anybody
 * else's read yet".
 *
 * A plain partial UNIQUE index (`runs_one_running_per_campaign`'s own
 * mechanism) does not generalise here: it can express "at most one", not
 * "at most `max_concurrent_runs`", and `max_concurrent_runs` is an
 * operator-configured integer, not always 1. A separately maintained
 * counter column plus an atomic `UPDATE ... RETURNING` would generalise,
 * but only if every place a run leaves `running` (success, failure,
 * cancellation, and dispatchRun's own early-failure branch) reliably
 * decrements it - miss one and a slot leaks forever. Ranking the live
 * `status = 'running'` rows needs no separate column and no decrement to
 * remember: the moment something flips a row away from `running`, the very
 * next admission check already sees the freed slot.
 *
 * Throws with a message that never contains "quota" or "rate limit" - the
 * budget refusal in `dispatchRun` does, and `classifyFailure`
 * (shared/src/runlog/classify-failure.ts) has to tell the two apart as
 * `concurrency_exhausted` vs `quota_exhausted` rather than folding both
 * into one label an operator can't act on without reading the run's raw
 * error.
 */
export async function assertOrgConcurrencyAdmitted(
  db: Db,
  orgId: number,
  runId: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [org] = await tx
      .select({ maxConcurrentRuns: schema.organizations.maxConcurrentRuns })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    const cap = org?.maxConcurrentRuns ?? null;
    if (cap == null) return; // unlimited - nothing to admit against.

    // Transaction-scoped: blocks any other admission decision for this org
    // until this one commits or rolls back, and releases automatically
    // either way - no separate cleanup path to forget.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`org-concurrency:${orgId}`}, 0))`,
    );

    const orgProjects = await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, orgId));
    const projectIds = orgProjects.map((p) => p.id);
    // No projects means no runs to rank against, including this one -
    // unreachable in practice (this run's own row implies a project) but
    // never treat "found nothing" as "refuse".
    if (projectIds.length === 0) return;

    const running = await tx
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
      .where(
        and(
          or(
            inArray(schema.runs.projectId, projectIds),
            inArray(schema.campaigns.projectId, projectIds),
          ),
          eq(schema.runs.status, 'running'),
        ),
      )
      .orderBy(schema.runs.id);

    const rank = running.findIndex((r) => r.id === runId) + 1; // 0 -> "not found"
    if (rank > 0 && rank <= cap) return; // admitted - within the cap.

    throw new Error(
      `This organization already has ${cap} cloud run${cap === 1 ? '' : 's'} in progress, its ` +
        `configured concurrency limit, and cannot start another until one finishes or an ` +
        `operator raises the limit in Settings.`,
    );
  });
}
