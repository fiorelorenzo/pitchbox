// The billing page (#555): the plan, what of it is used, and the two real
// ways to change it. Every metered number comes from `getOrgUsage`
// (`@pitchbox/shared/usage`), which itself calls `resolveEntitlements` -
// this loader never declares a limit, it only reads the org's own
// `organizations`/`org_subscriptions` rows for the display-only fields
// neither of those expose: the Stripe customer id (to decide whether the
// portal link is safe to show at all - matches `/api/billing/portal`'s own
// `NoStripeCustomerError` gate rather than guessing from `entitlements.source`),
// and the raw subscription period/cancel flag/status Stripe mirrors onto
// `org_subscriptions` (#551), which nothing meters and nothing else surfaces.
import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../../lib/server/db.js';
import { requireOrgId, requireRole } from '../../../lib/server/auth.js';
import { currentEdition } from '@pitchbox/shared/edition';
import { getOrgUsage, type UsageMetric } from '@pitchbox/shared/usage';
import {
  PLAN_CATALOGUE,
  PLAN_IDS,
  isOrgReadOnly,
  normalizePlanId,
  type Entitlements,
} from '@pitchbox/shared/plans';
import { billingPeriodFor } from '@pitchbox/shared/org-quota';

export type BillingUsage = {
  runs: UsageMetric;
  suggestions: UsageMetric;
  projects: UsageMetric;
  accounts: UsageMetric;
  seats: UsageMetric;
  extensionDevices: UsageMetric;
  /** LOR-182: never the raw dollar figures behind the plan's model-spend
   * ceiling (`entitlements.monthlyRunBudgetUsd`) - only the fraction of it
   * this org has used this period. `usedPercent` is null when the plan
   * carries no ceiling at all (unlimited), the same null-means-unlimited
   * convention every other `UsageMetric.limit` uses. `getOrgUsage` itself
   * keeps returning the USD number unchanged (`/settings/admin` and
   * enforcement still need it); `modelAllowanceUsage` below is the one
   * conversion point that turns it into what a tenant may see. */
  modelAllowance: { usedPercent: number | null };
};

export type PickablePlan = {
  id: string;
  name: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
};

export type BillingPageData =
  | { selfHost: true }
  | {
      selfHost: false;
      planId: string;
      planName: string;
      source: Entitlements['source'];
      priceCents: number | null;
      interval: 'month' | 'year' | null;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      /** LOR-157: a downgrade the customer portal deferred to period end
       * via a two-phase Subscription Schedule - the webhook mirrors it
       * onto `org_subscriptions.pending_plan_id`/`pending_plan_effective_at`
       * (docs/billing.md "Where a customer manages a subscription"). Both
       * null means no pending change; resolved to a plan name here rather
       * than a bare id for the same reason `planName` is, and for the same
       * client-bundle reason `pickablePlans` is plain data. */
      pendingPlanName: string | null;
      pendingPlanEffectiveAt: string | null;
      status: string | null;
      readOnly: boolean;
      graceEndsAt: string | null;
      hasStripeCustomer: boolean;
      usage: BillingUsage;
      /** The paid tiers a free (no Stripe customer, no grant) org can pick
       * from - plain data rather than a client-side import of
       * `@pitchbox/shared/plans`, which pulls in `db/client.js` and has no
       * business in a browser bundle (`do not import @pitchbox/shared/db
       * from client code`, AGENTS.md). */
      pickablePlans: PickablePlan[];
    };

// Nothing persists the interval a subscription was actually bought at -
// `org_subscriptions` mirrors only what enforcement reads (#551), and no
// enforcement point ever needs to tell month from year. Reading it back
// from the period Stripe already gave us (a month is never longer than 31
// days, a year is never shorter than 365) avoids adding a column whose only
// reader would be this page.
function intervalFromPeriod(start: Date, end: Date): 'month' | 'year' {
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  return days > 60 ? 'year' : 'month';
}

// LOR-182: the one place a tenant's model spend turns from the dollar
// figure `getOrgUsage` computes into the fraction of their plan's
// allowance they may actually see. Rounded to one decimal place so a
// nearly-exhausted allowance reads as "99.7%" rather than snapping to
// "100%" a run early; deliberately not clamped at 100, since a tenant who
// is already over their allowance needs to see that, not a bar frozen at
// full.
function modelAllowanceUsage(costUsd: UsageMetric): BillingUsage['modelAllowance'] {
  if (costUsd.limit == null) return { usedPercent: null };
  if (costUsd.limit <= 0) return { usedPercent: 100 };
  return { usedPercent: Math.round((costUsd.used / costUsd.limit) * 1000) / 10 };
}

export const load: PageServerLoad = async (event) => {
  // Billing is admin+, like retention/security/linkedin-assist/companion -
  // its loader throws rather than narrowing the payload like quota/runners
  // do, so a member's direct hit 403s instead of rendering a stripped-down
  // page (docs/permissions.md). The API (`/api/billing/checkout`,
  // `/api/billing/portal`) enforces the same gate independently either way.
  requireRole(event, 'admin');
  const orgId = await requireOrgId(event);

  // Self-host has no plan concept at all: `resolveEntitlements` returns the
  // unlimited shape with `source: 'self-host'` before it ever looks at
  // Stripe or the plan catalogue, because there is nothing to meter and
  // nothing to sell. The settings rail hides this link entirely for
  // self-host (matching how `organization` is hidden when auth is off) -
  // a billing page with no numbers and two dead buttons is worse than no
  // page, and the self-host operator already has full access with nothing
  // to decide here. This branch only covers a stray direct hit on the URL:
  // it says plainly that self-host is unlimited rather than inventing an
  // empty plan card full of dashes.
  if (currentEdition() !== 'cloud') {
    return { selfHost: true } satisfies BillingPageData;
  }

  const db = getDb();
  const [org] = await db
    .select({ stripeCustomerId: schema.organizations.stripeCustomerId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  const [sub] = await db
    .select({
      status: schema.orgSubscriptions.status,
      currentPeriodStart: schema.orgSubscriptions.currentPeriodStart,
      currentPeriodEnd: schema.orgSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: schema.orgSubscriptions.cancelAtPeriodEnd,
      pendingPlanId: schema.orgSubscriptions.pendingPlanId,
      pendingPlanEffectiveAt: schema.orgSubscriptions.pendingPlanEffectiveAt,
    })
    .from(schema.orgSubscriptions)
    .where(eq(schema.orgSubscriptions.organizationId, orgId))
    .limit(1);

  const period = await billingPeriodFor(db, orgId);
  const usage = await getOrgUsage(db, orgId, period);
  const entitlements = usage.entitlements;
  const plan = PLAN_CATALOGUE[entitlements.planId];
  const interval = sub ? intervalFromPeriod(sub.currentPeriodStart, sub.currentPeriodEnd) : null;

  return {
    selfHost: false,
    planId: entitlements.planId,
    planName: plan.name,
    source: entitlements.source,
    priceCents: interval === 'year' ? plan.annualPriceCents : plan.monthlyPriceCents,
    interval,
    currentPeriodEnd: sub ? sub.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    pendingPlanName:
      sub?.pendingPlanId != null ? PLAN_CATALOGUE[normalizePlanId(sub.pendingPlanId)].name : null,
    pendingPlanEffectiveAt: sub?.pendingPlanEffectiveAt
      ? sub.pendingPlanEffectiveAt.toISOString()
      : null,
    status: sub?.status ?? null,
    readOnly: isOrgReadOnly(entitlements),
    graceEndsAt: entitlements.graceEndsAt ? entitlements.graceEndsAt.toISOString() : null,
    // The real gate `/api/billing/portal` itself enforces (NoStripeCustomerError)
    // - a grant never has a customer id, so this is also what keeps the
    // portal link off a granted org without special-casing `source === 'grant'`.
    hasStripeCustomer: org?.stripeCustomerId != null,
    pickablePlans: PLAN_IDS.filter((id) => id !== 'free').map((id) => {
      const p = PLAN_CATALOGUE[id];
      return {
        id: p.id,
        name: p.name,
        monthlyPriceCents: p.monthlyPriceCents ?? 0,
        annualPriceCents: p.annualPriceCents ?? 0,
      };
    }),
    usage: {
      runs: usage.runs,
      suggestions: usage.suggestions,
      projects: usage.projects,
      accounts: usage.accounts,
      seats: usage.seats,
      extensionDevices: usage.extensionDevices,
      modelAllowance: modelAllowanceUsage(usage.costUsd),
    },
  } satisfies BillingPageData;
};
