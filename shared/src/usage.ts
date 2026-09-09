// The single answer to "how much of this org's plan is used" (#546). Every
// enforcement point in #548, the settings/billing page (#555), the pricing
// page's own account state (#558) and the extension payload (#556) read this
// one snapshot rather than five near-identical queries scattered across
// routes - a plan number that only `resolveEntitlements` (shared/src/plans.ts)
// may declare, and one place that turns it into "used" and "remaining".
import { and, count, eq, gt, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { resolveEntitlements, type Entitlements } from './plans.js';
import { getOrgPeriodCostUsd, type Period } from './org-quota.js';

/** One metered axis: how many the org has used, the plan's limit (null =
 * unlimited) and how many remain (null when the limit itself is null). */
export interface UsageMetric {
  used: number;
  limit: number | null;
  remaining: number | null;
}

/** Every number the plan catalogue meters for one org, over `period`
 * (`billingPeriodFor` in shared/src/org-quota.ts) where the axis is
 * period-bound, or as of now where it is a structural snapshot instead. */
export interface OrgUsageSnapshot {
  runs: UsageMetric;
  suggestions: UsageMetric;
  /** Structural, not period-bound: how many projects the org has right now. */
  projects: UsageMetric;
  /** Connected accounts, for display only - `limit` is always null. Plans.ts
   * carries a per-plan `accounts` number in `PLAN_CATALOGUE` for the pricing
   * page, but deliberately does not expose it on `Entitlements` yet (its own
   * doc comment: "no enforcement point reads a connected-account limit yet").
   * Extending `Entitlements` is plans.ts's contract, not this module's. */
  accounts: UsageMetric;
  /** Structural: memberships plus pending, unexpired invites - inviting ten
   * people at once has to consume the same seats a joined member would. */
  seats: UsageMetric;
  /** Structural: non-revoked, non-expired extension_devices rows. */
  extensionDevices: UsageMetric;
  costUsd: UsageMetric;
  /** The raw resolver output, for fields `UsageMetric` doesn't shape
   * (premiumModels, webhooks, retentionDays, maxConcurrentRuns, planId,
   * source) - callers that need those read them here instead of a second
   * `resolveEntitlements` call. */
  entitlements: Entitlements;
}

function metric(used: number, limit: number | null): UsageMetric {
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

const UNLIMITED_METRIC: UsageMetric = { used: 0, limit: null, remaining: null };

/**
 * One org's usage snapshot for `period`. Self-host (`entitlements.source ===
 * 'self-host'`) returns the fully-unlimited shape without running a single
 * count query - there is nothing to refuse, so there is nothing to count.
 *
 * Every other axis after that is at most one query, and the four structural
 * counts (projects, accounts, seats, extensionDevices) share one round trip
 * via `Promise.all` alongside the two period-bound counts (runs,
 * suggestions) and the existing cost helper - six queries total, none of
 * which grow with how many projects the org has.
 */
export async function getOrgUsage(
  db: Db,
  orgId: number,
  period: Period,
): Promise<OrgUsageSnapshot> {
  const entitlements = await resolveEntitlements(db, orgId);
  if (entitlements.source === 'self-host') {
    return {
      runs: UNLIMITED_METRIC,
      suggestions: UNLIMITED_METRIC,
      projects: UNLIMITED_METRIC,
      accounts: UNLIMITED_METRIC,
      seats: UNLIMITED_METRIC,
      extensionDevices: UNLIMITED_METRIC,
      costUsd: UNLIMITED_METRIC,
      entitlements,
    };
  }

  const orgProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, orgId));
  const projectIds = orgProjects.map((p) => p.id);
  const now = new Date();

  const [runsUsed, suggestionsUsed, accountsUsed, seatMembers, seatInvites, devicesUsed, costUsd] =
    await Promise.all([
      // Every run row for the org's projects in the period, whatever the
      // kind and whatever the status - a failed run still cost compute, and
      // a plan that only counts successes invites a retry loop.
      projectIds.length === 0
        ? Promise.resolve(0)
        : db
            .select({ n: count() })
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
            )
            .then(([r]) => Number(r?.n ?? 0)),
      // Produced suggestions, not accepted ones - the assist ledger (#522)
      // writes one row the moment a suggestion's stream finishes, whether or
      // not a human ever accepts it, and that is the moment the money (and
      // the plan's suggestion count) is actually spent.
      projectIds.length === 0
        ? Promise.resolve(0)
        : db
            .select({ n: count() })
            .from(schema.assistUsage)
            .where(
              and(
                inArray(schema.assistUsage.projectId, projectIds),
                gte(schema.assistUsage.createdAt, period.start),
                lt(schema.assistUsage.createdAt, period.end),
              ),
            )
            .then(([r]) => Number(r?.n ?? 0)),
      projectIds.length === 0
        ? Promise.resolve(0)
        : db
            .select({ n: count() })
            .from(schema.accounts)
            .where(
              and(inArray(schema.accounts.projectId, projectIds), eq(schema.accounts.active, true)),
            )
            .then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(schema.memberships)
        .where(eq(schema.memberships.organizationId, orgId))
        .then(([r]) => Number(r?.n ?? 0)),
      // A pending, unexpired invite consumes a seat too - otherwise the seat
      // limit is bypassed by inviting ten people at once and never having
      // any of them accept.
      db
        .select({ n: count() })
        .from(schema.orgInvites)
        .where(
          and(
            eq(schema.orgInvites.organizationId, orgId),
            isNull(schema.orgInvites.acceptedAt),
            gt(schema.orgInvites.expiresAt, now),
          ),
        )
        .then(([r]) => Number(r?.n ?? 0)),
      // Non-revoked, non-expired devices - a rotated-out device does not
      // consume a slot forever, matching requireExtensionAuth's own
      // liveness predicate (web/src/lib/server/extension-auth.ts).
      db
        .select({ n: count() })
        .from(schema.extensionDevices)
        .where(
          and(
            eq(schema.extensionDevices.organizationId, orgId),
            isNull(schema.extensionDevices.revokedAt),
            or(
              isNull(schema.extensionDevices.expiresAt),
              gt(schema.extensionDevices.expiresAt, now),
            ),
          ),
        )
        .then(([r]) => Number(r?.n ?? 0)),
      getOrgPeriodCostUsd(db, orgId, period),
    ]);

  const projectsUsed = projectIds.length;

  return {
    runs: metric(runsUsed, entitlements.runsPerMonth),
    suggestions: metric(suggestionsUsed, entitlements.suggestionsPerMonth),
    projects: metric(projectsUsed, entitlements.projects),
    accounts: metric(accountsUsed, null),
    seats: metric(seatMembers + seatInvites, entitlements.seats),
    extensionDevices: metric(devicesUsed, entitlements.extensionDevices),
    costUsd: metric(costUsd, entitlements.monthlyRunBudgetUsd),
    entitlements,
  };
}
