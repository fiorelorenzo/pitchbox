// The plan catalogue (#543): one object every entitlement check reads. Free,
// Solo, Growth and Scale, plus the resolver (`resolveEntitlements`) that
// turns an org id into the numbers that actually apply to it.
//
// The paid tiers' authoritative numbers do not live here - they live in
// Stripe product metadata (`scripts/stripe-setup.ts`, docs/billing.md "The
// plan catalogue lives in Stripe, not in the code", #588). That decision
// landed after this issue was written, and it changes what "one place" means
// without changing the rule: nothing outside this module may declare a plan
// limit. The catalogue below is what an org's entitlements resolve to
// *before* Stripe is asked - Free (which has no Stripe object at all, ever),
// a grant (never Stripe-backed by definition), and a subscription for which
// no webhook has mirrored anything onto `org_subscriptions` yet (#551 writes
// that table; a delivery gap or a subscription Stripe deleted out from under
// us both look like "no row" and fall back to this catalogue rather than to
// unlimited). The numbers here are kept equal to the Stripe metadata
// `scripts/stripe-setup.ts` writes and to the table in docs/billing.md - if
// the two ever disagree, the doc wins, since the script is what actually
// configures the running deployment.
//
// `webhooks` has no Stripe metadata counterpart - Stripe carries numeric
// limits, not feature flags - so it always comes from here, keyed by plan
// id, even for a mirrored subscription.
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { isCloud } from './edition.js';

export const PLAN_IDS = ['free', 'solo', 'growth', 'scale'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

/**
 * `value` if it names a real plan, else `'free'` - the fallback every
 * unresolvable plan id lands on (a stale row, a retired plan, a typo hand-
 * entered by a grant). Deliberately never "unlimited": that would give a
 * data bug the same effect as a paid subscription.
 */
export function normalizePlanId(value: string | null | undefined): PlanId {
  return isPlanId(value) ? value : 'free';
}

/**
 * The catalogue entry for one plan: every number in the epic's table
 * (#542), plus the display fields the pricing page and the settings UI
 * need. `accounts` (connected accounts per platform, or a flat cap on Free)
 * is carried here for display even though `Entitlements` below does not
 * expose it - no enforcement point reads a connected-account limit yet, and
 * inventing a field on the resolver's return type ahead of a real reader
 * would be exactly the kind of second copy this module exists to prevent.
 * When that enforcement lands, it reads `PLAN_CATALOGUE[planId].accounts`.
 */
export type PlanDefinition = {
  id: PlanId;
  name: string;
  /** Tax-exclusive EUR, minor units. USD carries the same headline number
   * (docs/billing.md "USD stays at numeric parity", #542 comment 2026-09-09),
   * so one figure serves both currencies' display. `null` on Free: it has no
   * price, not a price of zero to render. */
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  runsPerMonth: number | null;
  suggestionsPerMonth: number | null;
  projects: number | null;
  /** Connected accounts. Free is one per platform (a flat 1, not per-
   * platform metering); Growth and Scale are unlimited. */
  accounts: number | null;
  seats: number | null;
  extensionDevices: number | null;
  maxConcurrentRuns: number | null;
  monthlyRunBudgetUsd: number | null;
  retentionDays: number | null;
  premiumModels: boolean;
  webhooks: boolean;
};

/** The catalogue itself, exported directly rather than behind a getter -
 * indexing a plain object by a `PlanId` needs no indirection. */
export const PLAN_CATALOGUE: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceCents: null,
    annualPriceCents: null,
    runsPerMonth: 20,
    suggestionsPerMonth: 50,
    projects: 1,
    accounts: 1,
    seats: 1,
    extensionDevices: 1,
    maxConcurrentRuns: 1,
    monthlyRunBudgetUsd: 2,
    retentionDays: 14,
    premiumModels: false,
    webhooks: false,
  },
  solo: {
    id: 'solo',
    name: 'Pitchbox Solo',
    monthlyPriceCents: 2900,
    annualPriceCents: 29000,
    runsPerMonth: 500,
    suggestionsPerMonth: 500,
    projects: 3,
    accounts: 5,
    seats: 1,
    extensionDevices: 3,
    maxConcurrentRuns: 2,
    monthlyRunBudgetUsd: 10,
    retentionDays: 30,
    premiumModels: false,
    webhooks: false,
  },
  growth: {
    id: 'growth',
    name: 'Pitchbox Growth',
    monthlyPriceCents: 7900,
    annualPriceCents: 79000,
    runsPerMonth: 2000,
    suggestionsPerMonth: 2000,
    projects: 10,
    accounts: null,
    seats: 3,
    extensionDevices: 10,
    maxConcurrentRuns: 4,
    monthlyRunBudgetUsd: 30,
    retentionDays: 90,
    premiumModels: true,
    webhooks: true,
  },
  scale: {
    id: 'scale',
    name: 'Pitchbox Scale',
    monthlyPriceCents: 19900,
    annualPriceCents: 199000,
    runsPerMonth: 8000,
    suggestionsPerMonth: 8000,
    projects: 30,
    accounts: null,
    seats: 10,
    extensionDevices: null,
    maxConcurrentRuns: 8,
    monthlyRunBudgetUsd: 70,
    retentionDays: 180,
    premiumModels: true,
    webhooks: true,
  },
};

/** Every plan, Free through Scale, in ladder order - the pricing page's
 * only reader of the catalogue (#558, not built here). */
export function listPlans(): PlanDefinition[] {
  return PLAN_IDS.map((id) => PLAN_CATALOGUE[id]);
}

/**
 * The `lookup_key` a paid plan's Stripe price resolves under
 * (docs/billing.md "The app resolves prices by lookup_key, never by id"):
 * `pitchbox_<planId>_monthly` / `pitchbox_<planId>_yearly`, exactly what
 * `scripts/stripe-setup.ts` writes. Free has no Stripe object, so no plan
 * ever asks this for `'free'`; callers that might still try get `null`
 * rather than a key that resolves nothing.
 */
export function stripeLookupKey(planId: PlanId, interval: 'monthly' | 'yearly'): string | null {
  if (planId === 'free') return null;
  return `pitchbox_${planId}_${interval === 'monthly' ? 'monthly' : 'yearly'}`;
}

/**
 * The effective limits and features for an organization - the only shape
 * any enforcement point, settings form, pricing page or extension payload
 * may read a plan number from. `null` on a numeric field means unlimited,
 * the same convention `organizations.monthly_run_budget_usd` already uses;
 * there is no second sentinel.
 */
export type Entitlements = {
  runsPerMonth: number | null;
  suggestionsPerMonth: number | null;
  projects: number | null;
  seats: number | null;
  extensionDevices: number | null;
  maxConcurrentRuns: number | null;
  monthlyRunBudgetUsd: number | null;
  retentionDays: number | null;
  premiumModels: boolean;
  webhooks: boolean;
  planId: PlanId;
  /** Where these numbers came from: 'self-host' (edition override, always
   * unlimited), 'grant' (an instance admin set the plan by hand), 'subscription'
   * (mirrored from a live Stripe subscription), or 'default' (the code
   * catalogue, because nothing above applied - the common case for Free). */
  source: 'self-host' | 'grant' | 'subscription' | 'default';
};

/**
 * Resolves the entitlements an organization actually gets, in precedence
 * order: self-host beats everything (no cloud edition, no billing, full
 * access); an instance-admin grant beats a live subscription (`setOrgPlan`
 * in `shared/src/orgs.ts` is the only writer of a grant, and it is meant to
 * survive whatever Stripe says about the same org); a mirrored subscription
 * beats the code catalogue (docs/billing.md: the catalogue in Stripe product
 * metadata is authoritative for a paying org); the code catalogue, keyed by
 * `organizations.plan` and normalized to `'free'` if that value does not
 * name a real plan, is the fallback everything else lands on.
 */
export async function resolveEntitlements(db: Db, orgId: number): Promise<Entitlements> {
  const [org] = await db
    .select({ plan: schema.organizations.plan, planSource: schema.organizations.planSource })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  const planId = normalizePlanId(org?.plan);

  if (!isCloud()) {
    return {
      runsPerMonth: null,
      suggestionsPerMonth: null,
      projects: null,
      seats: null,
      extensionDevices: null,
      maxConcurrentRuns: null,
      monthlyRunBudgetUsd: null,
      retentionDays: null,
      premiumModels: true,
      webhooks: true,
      planId,
      source: 'self-host',
    };
  }

  // A grant never consults the subscription row at all: it must survive
  // whatever Stripe says about the same org, not merely outrank it once
  // both are read.
  if (org?.planSource !== 'grant') {
    const [sub] = await db
      .select()
      .from(schema.orgSubscriptions)
      .where(eq(schema.orgSubscriptions.organizationId, orgId))
      .limit(1);
    if (sub) {
      return {
        runsPerMonth: sub.limitRuns,
        suggestionsPerMonth: sub.limitSuggestions,
        projects: sub.limitProjects,
        seats: sub.limitSeats,
        extensionDevices: sub.limitDevices,
        maxConcurrentRuns: sub.limitConcurrency,
        monthlyRunBudgetUsd: sub.limitBudgetUsd == null ? null : Number(sub.limitBudgetUsd),
        retentionDays: sub.limitRetentionDays,
        premiumModels: sub.limitPremiumModels,
        webhooks: PLAN_CATALOGUE[normalizePlanId(sub.planId)].webhooks,
        planId: normalizePlanId(sub.planId),
        source: 'subscription',
      };
    }
  }

  const plan = PLAN_CATALOGUE[planId];
  return {
    runsPerMonth: plan.runsPerMonth,
    suggestionsPerMonth: plan.suggestionsPerMonth,
    projects: plan.projects,
    seats: plan.seats,
    extensionDevices: plan.extensionDevices,
    maxConcurrentRuns: plan.maxConcurrentRuns,
    monthlyRunBudgetUsd: plan.monthlyRunBudgetUsd,
    retentionDays: plan.retentionDays,
    premiumModels: plan.premiumModels,
    webhooks: plan.webhooks,
    planId: plan.id,
    source: org?.planSource === 'grant' ? 'grant' : 'default',
  };
}
