// Per-org run quota. Computes an org's remaining monthly USD run budget and
// its concurrency cap, enforced before a run starts and while it streams
// (shared/src/agents/sdk/runner.ts, web/src/lib/server/runner.ts). Mirrors the
// per-account quota helper's style (shared/src/quota.ts) but is org-scoped and
// budget/concurrency based rather than per-account daily/weekly counts.
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { schema, type Db } from './db/client.js';

// The loose handle orgs.ts already uses, rather than the strict `Db` above:
// loadOrgQuotaDefaults is called from createOrganization
// (shared/src/orgs.ts), which may be holding a transaction handle
// mid-registration, and the strict schema-bound type rejects that handle.
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

/**
 * The budget/concurrency a *self-registered* org gets at creation - #540.
 * Deliberately a separate `app_config` key from `org_quota_defaults` above
 * rather than a smaller value in the same key: raising what an invited or
 * paying tenant gets (`org_quota_defaults`) must never also raise what a
 * stranger who typed an email into `/register` gets, and a single shared
 * key can't express two different numbers for two different trust levels.
 * Read by `createOrganization`'s no-invite branch only (shared/src/orgs.ts)
 * - an existing, already-authenticated user creating an additional org via
 * `POST /api/orgs` still gets `org_quota_defaults`, since that caller
 * already has an account on this instance, invited or not.
 */
export type SelfRegistrationQuotaDefaults = {
  monthlyRunBudgetUsd: number;
  maxConcurrentRuns: number;
};

const SELF_REGISTRATION_QUOTA_DEFAULTS_KEY = 'self_registration_quota_defaults';

// Seeded by seed-core.ts alongside ORG_QUOTA_DEFAULTS_FALLBACK, and the
// fallback when the app_config row is missing or malformed. Single-digit
// USD on purpose (#540): a stranger who just registered has had zero
// human review, unlike an invited or manually-provisioned org.
export const SELF_REGISTRATION_QUOTA_DEFAULTS_FALLBACK: SelfRegistrationQuotaDefaults = {
  monthlyRunBudgetUsd: 5,
  maxConcurrentRuns: 1,
};

export async function loadSelfRegistrationQuotaDefaults(
  db: AnyDb,
): Promise<SelfRegistrationQuotaDefaults> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, SELF_REGISTRATION_QUOTA_DEFAULTS_KEY))
    .limit(1);
  const value = row?.value as Partial<Record<string, unknown>> | undefined;
  const budget = Number(value?.monthlyRunBudgetUsd);
  const concurrency = Number(value?.maxConcurrentRuns);
  return {
    monthlyRunBudgetUsd:
      Number.isFinite(budget) && budget > 0
        ? budget
        : SELF_REGISTRATION_QUOTA_DEFAULTS_FALLBACK.monthlyRunBudgetUsd,
    maxConcurrentRuns:
      Number.isFinite(concurrency) && concurrency > 0
        ? Math.floor(concurrency)
        : SELF_REGISTRATION_QUOTA_DEFAULTS_FALLBACK.maxConcurrentRuns,
  };
}

/** Persists the self-registration defaults (instance admin area, #540). */
export async function saveSelfRegistrationQuotaDefaults(
  db: Db,
  defaults: SelfRegistrationQuotaDefaults,
): Promise<SelfRegistrationQuotaDefaults> {
  await db
    .insert(schema.appConfig)
    .values({ key: SELF_REGISTRATION_QUOTA_DEFAULTS_KEY, value: defaults })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value: defaults } });
  return defaults;
}

/** First instant (UTC) of the calendar month containing `now`. Kept for
 * exactly one caller after #545: `getInstanceMonthToDateCostUsd` sums every
 * organization's spend over the SAME plain calendar month regardless of any
 * one org's own billing period, which is the instance-wide ceiling's
 * existing meaning and #545 deliberately leaves unchanged. No other caller
 * should reappear here - an org's own spend window is `billingPeriodFor`
 * below. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** `date`'s day-of-month (and time-of-day) shifted by `months`, clamped to
 * the target month's real length (e.g. Jan 31 + 1 month -> Feb 28/29, never
 * Mar 3). The building block both `calendarPeriodFor` and the instance-wide
 * calendar-month period use. */
function addUtcMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDayOfTargetMonth);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** A half-open spend window `[start, end)`. */
export interface Period {
  start: Date;
  end: Date;
}

/** The plain calendar-month window `getInstanceMonthToDateCostUsd` sums
 * every org over - the 1st of the month to the 1st of the next, in UTC.
 * Deliberately NOT anchored on anything org-specific: see `startOfMonthUtc`'s
 * own doc comment for why the instance-wide ceiling keeps this window
 * regardless of what `billingPeriodFor` computes for any one org. */
function calendarMonthPeriod(now: Date): Period {
  const start = startOfMonthUtc(now);
  return { start, end: addUtcMonths(start, 1) };
}

function monthsBetweenUtc(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  );
}

/**
 * The calendar-month period containing `now`, anchored on `anchor`'s
 * day-of-month (and time-of-day) rather than the 1st - #545. An org that
 * never subscribes gets this window, anchored on its own `createdAt`: a free
 * org's spend window is therefore stable for the org's whole lifetime and
 * does not shift merely because it later subscribes or its subscription
 * later lapses, since it is always derived from `organizations.createdAt`,
 * never from Stripe.
 */
export function calendarPeriodFor(anchor: Date, now: Date): Period {
  let months = monthsBetweenUtc(anchor, now);
  let start = addUtcMonths(anchor, months);
  if (start > now) {
    months -= 1;
    start = addUtcMonths(anchor, months);
  }
  let end = addUtcMonths(anchor, months + 1);
  // The initial estimate above can land one month short or long once
  // month-end clamping is in play (e.g. an anchor on the 31st produces a
  // 28-day February) - walk to the exact window containing `now` rather
  // than trusting the arithmetic estimate.
  while (end <= now) {
    months += 1;
    start = end;
    end = addUtcMonths(anchor, months + 1);
  }
  while (start > now) {
    months -= 1;
    end = start;
    start = addUtcMonths(anchor, months);
  }
  return { start, end };
}

/**
 * Pure period resolution given already-loaded org data - the part of
 * `billingPeriodFor` worth unit-testing with a fixed clock and no database.
 * A live subscription's period always wins; otherwise the org's own
 * creation-anchored calendar month (see `calendarPeriodFor`).
 */
export function resolveBillingPeriod(
  input: { orgCreatedAt: Date; subscriptionPeriod: Period | null },
  now: Date,
): Period {
  if (input.subscriptionPeriod) return input.subscriptionPeriod;
  return calendarPeriodFor(input.orgCreatedAt, now);
}

/**
 * An org's current spend window (#545): a live subscription's own
 * `current_period_start`/`current_period_end` as the Stripe webhook mirrors
 * them onto `org_subscriptions`, or the free/self-host calendar-month
 * fallback above. This is what a budget decision, the dashboard, the
 * org-quota settings page and every plan-limit check meter "this period"
 * against - see `resolveBillingPeriod` for the pure resolution rule.
 */
export async function billingPeriodFor(
  db: Db,
  orgId: number,
  now: Date = new Date(),
): Promise<Period> {
  const [row] = await db
    .select({
      orgCreatedAt: schema.organizations.createdAt,
      currentPeriodStart: schema.orgSubscriptions.currentPeriodStart,
      currentPeriodEnd: schema.orgSubscriptions.currentPeriodEnd,
    })
    .from(schema.organizations)
    .leftJoin(
      schema.orgSubscriptions,
      eq(schema.orgSubscriptions.organizationId, schema.organizations.id),
    )
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  // An org that no longer exists has nothing left to meter - the org lookup
  // elsewhere in the dispatch path is what actually refuses that case; this
  // just needs to not throw, so it anchors on `now` itself.
  const orgCreatedAt = row?.orgCreatedAt ?? now;
  const subscriptionPeriod =
    row?.currentPeriodStart != null && row?.currentPeriodEnd != null
      ? { start: row.currentPeriodStart, end: row.currentPeriodEnd }
      : null;
  return resolveBillingPeriod({ orgCreatedAt, subscriptionPeriod }, now);
}

/**
 * Org spend within `period`, split into campaign/other-run cost and
 * assistant (in-page suggestion) cost. #522: the assistant plane writes no
 * `runs` row for a suggestion (see web/src/routes/api/extension/suggest -
 * a suggestion is ephemeral until a human accepts it), so its spend lives in
 * `assist_usage` instead, one row per finished suggestion whether accepted
 * or not. Kept apart rather than pre-summed, per #522's decision: an
 * operator asking "why am I out of budget" needs to see which half spent it
 * (`getOrgPeriodCostUsd` below still returns the single number a budget
 * decision needs).
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
 * project references resolve.
 *
 * `assist_usage` is filtered by `organizationId` directly rather than
 * through the org's project ids: #523 made `assist_usage.project_id`
 * nullable (a suggestion can be about no product at all), so an org with
 * zero projects can still have assist spend to sum, which a project-id-only
 * early return used to silently drop.
 */
export interface OrgPeriodSpend {
  campaignUsd: number;
  assistantUsd: number;
  totalUsd: number;
}

export async function getOrgPeriodSpend(
  db: Db,
  orgId: number,
  period: Period,
): Promise<OrgPeriodSpend> {
  const orgProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, orgId));
  const projectIds = orgProjects.map((p) => p.id);

  const [runRow] =
    projectIds.length === 0
      ? [{ total: '0' }]
      : await db
          .select({ total: sql<string>`coalesce(sum(${schema.runs.costUsd}), 0)` })
          .from(schema.runs)
          .leftJoin(schema.campaigns, eq(schema.campaigns.id, schema.runs.campaignId))
          .where(
            and(
              or(
                inArray(schema.runs.projectId, projectIds),
                inArray(schema.campaigns.projectId, projectIds),
              ),
              gte(schema.runs.startedAt, period.start),
              lt(schema.runs.startedAt, period.end),
            ),
          );

  const [assistRow] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.assistUsage.costUsd}), 0)` })
    .from(schema.assistUsage)
    .where(
      and(
        eq(schema.assistUsage.organizationId, orgId),
        gte(schema.assistUsage.createdAt, period.start),
        lt(schema.assistUsage.createdAt, period.end),
      ),
    );

  const campaignUsd = Number(runRow?.total ?? 0);
  const assistantUsd = Number(assistRow?.total ?? 0);
  return { campaignUsd, assistantUsd, totalUsd: campaignUsd + assistantUsd };
}

/**
 * The single number a budget decision uses (org-quota's own gate in
 * getOrgQuotaSnapshot, the instance-wide ceiling): campaign spend plus
 * assistant spend, within `period`. See getOrgPeriodSpend for the split and
 * why the two are kept apart for a human but combined here for a cap.
 */
export async function getOrgPeriodCostUsd(db: Db, orgId: number, period: Period): Promise<number> {
  const { totalUsd } = await getOrgPeriodSpend(db, orgId, period);
  return totalUsd;
}

/**
 * Compute an org's current quota snapshot: remaining budget for its current
 * billing period (null = unlimited, since `organizations.monthlyRunBudgetUsd`
 * is null) and its concurrency cap (null = unlimited,
 * `organizations.max_concurrent_runs` null). A `remainingUsd` of 0 or
 * negative means the org is over budget. An org that no longer exists is
 * treated as unlimited on both axes - not this function's decision to make;
 * the org lookup elsewhere in the dispatch path is what actually gates a run
 * against a missing org.
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

  const period = await billingPeriodFor(db, orgId, now);
  const spentUsd = await getOrgPeriodCostUsd(db, orgId, period);
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

/**
 * The instance-wide monthly Gateway ceiling - #540. Opening registration
 * (#423) turns a per-org cap into an unbounded instance-wide one: a hundred
 * self-registered orgs each safely under their own budget still sums to a
 * real bill nobody capped. `null` means unlimited, the same convention as
 * `organizations.monthlyRunBudgetUsd` - an operator who genuinely wants no
 * instance-wide ceiling (a single-tenant self-host, say) can still choose
 * that explicitly, but a missing/unset app_config row falls back to a real
 * number rather than to unlimited, so the ceiling protects a fresh install
 * before anyone has visited the instance admin area to configure one.
 */
export type InstanceQuotaCeiling = {
  monthlyBudgetUsd: number | null;
};

const INSTANCE_QUOTA_CEILING_KEY = 'instance_quota_ceiling';

// Seeded by seed-core.ts alongside the other quota defaults, and the
// fallback when the app_config row is missing or holds something
// malformed. Sized so a hundred self-registered orgs at their own
// SELF_REGISTRATION_QUOTA_DEFAULTS_FALLBACK budget ($5 each) still sit
// under it - the ceiling is a backstop for every org's own budget being
// raised or exceeded together, not a number tuned to never bite.
export const INSTANCE_QUOTA_CEILING_FALLBACK: InstanceQuotaCeiling = {
  monthlyBudgetUsd: 500,
};

export async function loadInstanceQuotaCeiling(db: AnyDb): Promise<InstanceQuotaCeiling> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, INSTANCE_QUOTA_CEILING_KEY))
    .limit(1);
  if (!row) return { ...INSTANCE_QUOTA_CEILING_FALLBACK };
  const raw = (row.value as { monthlyBudgetUsd?: unknown } | undefined)?.monthlyBudgetUsd;
  if (raw === null) return { monthlyBudgetUsd: null }; // explicit unlimited.
  const n = Number(raw);
  return {
    monthlyBudgetUsd:
      Number.isFinite(n) && n >= 0 ? n : INSTANCE_QUOTA_CEILING_FALLBACK.monthlyBudgetUsd,
  };
}

/** Persists the instance-wide ceiling (instance admin area, #540). */
export async function saveInstanceQuotaCeiling(
  db: Db,
  ceiling: InstanceQuotaCeiling,
): Promise<InstanceQuotaCeiling> {
  const value = { monthlyBudgetUsd: ceiling.monthlyBudgetUsd };
  await db
    .insert(schema.appConfig)
    .values({ key: INSTANCE_QUOTA_CEILING_KEY, value })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value } });
  return ceiling;
}

/**
 * Sum of every organization's calendar-month-to-date Gateway spend - the
 * instance-wide total #540 checks the ceiling against. Deliberately the
 * plain calendar month (`calendarMonthPeriod`, the 1st of the month to the
 * 1st of the next), the SAME window for every org regardless of any one
 * org's own billing period (`billingPeriodFor`) - #545 introduced per-org
 * billing periods without changing what this instance-wide ceiling means:
 * one consistent window an operator can reason about across every tenant,
 * not a hundred different subscription anniversaries. Calls
 * `getOrgPeriodCostUsd` once per organization and adds the results, rather
 * than re-deriving its own SUM query, so this total always agrees with the
 * per-org figure's own spend accounting (#522: the in-page assistant's own
 * Gateway calls, which carry no `runs` row) with no second place to update.
 */
export async function getInstanceMonthToDateCostUsd(
  db: Db,
  now: Date = new Date(),
): Promise<number> {
  const period = calendarMonthPeriod(now);
  const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations);
  if (orgs.length === 0) return 0;
  const totals = await Promise.all(orgs.map((o) => getOrgPeriodCostUsd(db, o.id, period)));
  return totals.reduce((sum, t) => sum + t, 0);
}

/**
 * Instance-wide quota snapshot: remaining monthly USD Gateway budget across
 * every organization (null = unlimited, `instance_quota_ceiling` explicitly
 * set to null). A `remainingUsd` of 0 or negative means the instance is
 * over its ceiling - checked in `web/src/lib/server/runner.ts` next to the
 * per-org check, with its own refusal reason (`instance_quota_exhausted`,
 * shared/src/runlog/classify-failure.ts) so an operator reading a failed
 * run can tell "this tenant is out of budget" from "the instance is".
 */
export async function getInstanceQuotaSnapshot(
  db: Db,
  now: Date = new Date(),
): Promise<{ remainingUsd: number | null }> {
  const ceiling = await loadInstanceQuotaCeiling(db);
  if (ceiling.monthlyBudgetUsd == null) return { remainingUsd: null };
  const spentUsd = await getInstanceMonthToDateCostUsd(db, now);
  return { remainingUsd: ceiling.monthlyBudgetUsd - spentUsd };
}
