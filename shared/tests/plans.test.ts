// Exercises shared/src/plans.ts's resolveEntitlements: the precedence order
// between self-host, an instance-admin grant, a mirrored Stripe subscription
// and the code catalogue's fallback (#543/#544). Deliberately not testing
// the free plan's numbers by writing them out again - PLAN_CATALOGUE.free is
// already the single source, restating it in an assertion would only prove
// the test copied the module correctly.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { PLAN_CATALOGUE, resolveEntitlements } from '../src/plans.js';
import { setOrgPlan } from '../src/orgs.js';

const createdOrgIds: number[] = [];
const savedEdition = process.env.PITCHBOX_EDITION;

afterEach(async () => {
  const db = getDb();
  while (createdOrgIds.length > 0) {
    const id = createdOrgIds.pop()!;
    // org_subscriptions is onDelete: 'cascade' off organizations.
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
  if (savedEdition === undefined) delete process.env.PITCHBOX_EDITION;
  else process.env.PITCHBOX_EDITION = savedEdition;
});

async function makeOrg(overrides: { plan?: string; planSource?: string } = {}) {
  const db = getDb();
  const slug = `plans-test-${randomUUID()}`;
  const [org] = await db
    .insert(schema.organizations)
    .values({
      slug,
      name: slug,
      ...(overrides.plan ? { plan: overrides.plan } : {}),
      ...(overrides.planSource ? { planSource: overrides.planSource } : {}),
    })
    .returning();
  createdOrgIds.push(org.id);
  return org.id;
}

describe('resolveEntitlements', () => {
  it('self-host: unlimited on every axis regardless of the stored plan', async () => {
    process.env.PITCHBOX_EDITION = 'self-hosted';
    const orgId = await makeOrg({ plan: 'scale', planSource: 'grant' });
    const entitlements = await resolveEntitlements(getDb(), orgId);
    expect(entitlements.source).toBe('self-host');
    expect(entitlements.runsPerMonth).toBeNull();
    expect(entitlements.suggestionsPerMonth).toBeNull();
    expect(entitlements.projects).toBeNull();
    expect(entitlements.seats).toBeNull();
    expect(entitlements.extensionDevices).toBeNull();
    expect(entitlements.maxConcurrentRuns).toBeNull();
    expect(entitlements.monthlyRunBudgetUsd).toBeNull();
    expect(entitlements.retentionDays).toBeNull();
    expect(entitlements.premiumModels).toBe(true);
    expect(entitlements.webhooks).toBe(true);
  });

  it('a grant beats a subscription, even a later one mirrored for the same org', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const db = getDb();
    const orgId = await makeOrg();
    const granted = await setOrgPlan(db, orgId, 'scale', 'grant');
    expect(granted).toBe(true);

    // Simulate what the Stripe webhook (#551, not built here) would write on
    // a later `customer.subscription.updated` for the same org: a real
    // mirrored subscription, on a lower plan than the grant.
    await db.insert(schema.orgSubscriptions).values({
      organizationId: orgId,
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: `sub_test_${randomUUID()}`,
      planId: 'solo',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      limitRuns: PLAN_CATALOGUE.solo.runsPerMonth,
      limitSuggestions: PLAN_CATALOGUE.solo.suggestionsPerMonth,
      limitProjects: PLAN_CATALOGUE.solo.projects,
      limitSeats: PLAN_CATALOGUE.solo.seats,
      limitDevices: PLAN_CATALOGUE.solo.extensionDevices,
      limitConcurrency: PLAN_CATALOGUE.solo.maxConcurrentRuns,
      limitBudgetUsd: String(PLAN_CATALOGUE.solo.monthlyRunBudgetUsd),
      limitRetentionDays: PLAN_CATALOGUE.solo.retentionDays,
      limitPremiumModels: PLAN_CATALOGUE.solo.premiumModels,
    });

    const entitlements = await resolveEntitlements(db, orgId);
    expect(entitlements.source).toBe('grant');
    expect(entitlements.planId).toBe('scale');
    expect(entitlements.runsPerMonth).toBe(PLAN_CATALOGUE.scale.runsPerMonth);
    expect(entitlements.maxConcurrentRuns).toBe(PLAN_CATALOGUE.scale.maxConcurrentRuns);
  });

  it('an unknown plan id falls back to free, not to unlimited', async () => {
    process.env.PITCHBOX_EDITION = 'cloud';
    const orgId = await makeOrg({ plan: 'enterprise-legacy-typo', planSource: 'default' });
    const entitlements = await resolveEntitlements(getDb(), orgId);
    expect(entitlements.source).toBe('default');
    expect(entitlements.planId).toBe('free');
    expect(entitlements.runsPerMonth).toBe(PLAN_CATALOGUE.free.runsPerMonth);
    expect(entitlements.projects).toBe(PLAN_CATALOGUE.free.projects);
    expect(entitlements.premiumModels).toBe(false);
  });
});
