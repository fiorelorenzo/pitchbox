// LOR-182: on cloud, a tenant is shown what their runs cost the deployment -
// the Gateway bill, not something they bought. The dashboard's two spend
// cards, `/settings/billing`'s "Model spend this period" and
// `/settings/organization`'s month-to-date cost all rendered a USD figure
// derived from `runs.cost_usd`/`assist_usage.cost_usd`, org-scoped but still
// the deployment's own economics. This file proves each of the three
// loaders stops returning a dollar figure once `PITCHBOX_EDITION=cloud`,
// and that self-host (edition unset) is unaffected - `getOrgUsage`
// (shared/src/usage.ts) itself is untouched by this issue and keeps
// computing `costUsd` in USD for `/settings/admin` and enforcement; only
// what these three loaders hand a tenant-facing page changes.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { skipOnboarding } from '@pitchbox/shared/onboarding';
import { load as homeLoad } from '../src/routes/+page.server.js';
import { load as billingLoad } from '../src/routes/settings/billing/+page.server.js';
import type { BillingPageData } from '../src/routes/settings/billing/+page.server.js';
import { load as orgLoad } from '../src/routes/settings/organization/+page.server.js';

async function reset() {
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

/**
 * An org with a single project and one run carrying a known `cost_usd`,
 * landed "now" so it falls inside both the dashboard's 24h/7d windows and
 * `billingPeriodFor`'s creation-anchored calendar month. No campaign is
 * needed: every spend query this file exercises matches on
 * `runs.project_id` directly (`runOrgMatch` in the dashboard loader,
 * `getOrgPeriodSpend` in shared/src/org-quota.ts), a campaign is only the
 * *other* half of that `or()`. Onboarding is explicitly skipped so the
 * dashboard loader renders instead of redirecting to `/onboarding` (#609).
 */
async function seedOrgWithRunCost(
  slug: string,
  costUsd: string,
  opts: { monthlyRunBudgetUsd?: string | null } = {},
): Promise<number> {
  const db = getDb();
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug, monthlyRunBudgetUsd: opts.monthlyRunBudgetUsd ?? null })
    .returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `${slug}-proj`, name: `${slug} project` })
    .returning();
  // `kind: 'project_extraction'` is the simplest kind `runs_kind_target_chk`
  // accepts against a bare project with no campaign (matches
  // shared/tests/org-quota.test.ts's own fixture).
  await db.insert(schema.runs).values({
    kind: 'project_extraction',
    projectId: project.id,
    trigger: 'manual',
    status: 'succeeded',
    startedAt: new Date(),
    costUsd,
  });
  await skipOnboarding(
    db,
    { organizationId: org.id, userId: null },
    { authOn: false, username: null },
  );
  return org.id;
}

// `settings/billing` and `settings/organization` type their loader as the
// generated `PageServerLoad` (a `ServerLoadEvent`, stricter than the plain
// `RequestEvent` the dashboard loader takes) - same trap and same fix as
// route-guards-aggregates.test.ts's own `loadEvent`: build the fake event
// from the loader's own inferred parameter type instead of the generic one.
function loadEvent<Load extends (event: never) => unknown>(
  orgId: number,
  role: 'member' | 'admin' | 'owner',
): Parameters<Load>[0] {
  return {
    locals: { org: { id: orgId, slug: 'x', role } },
    url: new URL('http://x/'),
    params: {},
  } as unknown as Parameters<Load>[0];
}

describe('dashboard spend cards (LOR-182)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;

  beforeEach(reset);
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  // The loader never reads `event.locals.org.role` at all - the gate is
  // edition-only - so a member and an org owner are the same code path
  // here; testing both would just be the same assertion twice.
  it('cloud: a member gets no spend figure at all', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const orgId = await seedOrgWithRunCost('dash-cloud-member', '3.0000');
    const data = await homeLoad(loadEvent<typeof homeLoad>(orgId, 'member'));
    expect(data.spend).toBeNull();
  });

  it('self-host (edition unset): the spend cards keep their real numbers', async () => {
    delete process.env.PITCHBOX_EDITION;
    const orgId = await seedOrgWithRunCost('dash-self-host', '3.0000');
    const data = await homeLoad(loadEvent<typeof homeLoad>(orgId, 'member'));
    expect(data.spend).toEqual({ cost24h: 3, cost7d: 3, assistCost24h: 0, assistCost7d: 0 });
  });
});

describe('settings/billing "Model spend this period" (LOR-182)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;

  beforeEach(async () => {
    await reset();
    process.env.PITCHBOX_EDITION = 'cloud';
  });
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('an org owner sees a percentage of their allowance, never the dollar figures behind it', async () => {
    // Free's monthlyRunBudgetUsd is 2 (shared/src/plans.ts); $1 spent is 50%.
    const orgId = await seedOrgWithRunCost('billing-owner-cloud', '1.0000');
    const data = (await billingLoad(
      loadEvent<typeof billingLoad>(orgId, 'owner'),
    )) as BillingPageData;
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.usage.modelAllowance).toEqual({ usedPercent: 50 });
    expect('costUsd' in data.usage).toBe(false);
    expect(JSON.stringify(data)).not.toContain('costUsd');
  });

  it('a subscription with no budget ceiling reports "unlimited" rather than a dollar figure', async () => {
    const orgId = await seedOrgWithRunCost('billing-unlimited-cloud', '1.0000');
    await getDb()
      .update(schema.organizations)
      .set({ plan: 'growth', planSource: 'stripe' })
      .where(eq(schema.organizations.id, orgId));
    const now = new Date();
    await getDb()
      .insert(schema.orgSubscriptions)
      .values({
        organizationId: orgId,
        stripeCustomerId: `cus_${orgId}`,
        stripeSubscriptionId: `sub_${orgId}`,
        planId: 'growth',
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        limitRuns: 2000,
        limitSuggestions: 2000,
        limitProjects: 10,
        limitSeats: 3,
        limitDevices: 10,
        limitConcurrency: 4,
        // The one path `resolveEntitlements` can actually return
        // `monthlyRunBudgetUsd: null` on cloud: a mirrored subscription
        // whose metadata carries no budget limit at all.
        limitBudgetUsd: null,
        limitRetentionDays: 90,
        limitPremiumModels: true,
      });
    const data = (await billingLoad(
      loadEvent<typeof billingLoad>(orgId, 'owner'),
    )) as BillingPageData;
    if (data.selfHost) throw new Error('expected cloud data');
    expect(data.usage.modelAllowance).toEqual({ usedPercent: null });
  });
});

type OrgQuota = {
  monthlyRunBudgetUsd: number | null;
  maxConcurrentRuns: number | null;
  monthToDateCostUsd: number;
  campaignUsd: number;
  assistantUsd: number;
  remainingUsd: number | null;
} | null;

describe('settings/organization month-to-date cost (LOR-182)', () => {
  const savedEdition = process.env.PITCHBOX_EDITION;

  beforeEach(reset);
  afterEach(() => {
    if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
    else process.env.PITCHBOX_EDITION = savedEdition;
  });

  it('cloud: an org owner (not an instance admin) gets no quota/spend card', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const orgId = await seedOrgWithRunCost('org-owner-cloud', '1.0000', {
      monthlyRunBudgetUsd: '2.00',
    });
    const data = (await orgLoad(loadEvent<typeof orgLoad>(orgId, 'owner'))) as { quota: OrgQuota };
    expect(data.quota).toBeNull();
  });

  it('self-host (edition unset): the quota card keeps its real numbers', async () => {
    delete process.env.PITCHBOX_EDITION;
    const orgId = await seedOrgWithRunCost('org-owner-self-host', '1.0000', {
      monthlyRunBudgetUsd: '2.00',
    });
    const data = (await orgLoad(loadEvent<typeof orgLoad>(orgId, 'owner'))) as { quota: OrgQuota };
    expect(data.quota).not.toBeNull();
    expect(data.quota?.monthlyRunBudgetUsd).toBe(2);
    expect(data.quota?.monthToDateCostUsd).toBe(1);
    expect(data.quota?.campaignUsd).toBe(1);
    expect(data.quota?.remainingUsd).toBe(1);
  });
});
