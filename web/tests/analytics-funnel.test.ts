import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { GET } from '../src/routes/api/analytics/funnel/+server.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events, run_events RESTART IDENTITY CASCADE`,
  );
}

async function seed() {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: 'funnel-test', name: 'funnel-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'funnel-acc' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c1', skillSlug: 'reddit-scout' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, projectId: proj.id, trigger: 'manual', status: 'success' })
    .returning();

  // Mix of states: 3 pending_review, 2 approved, 1 sent, 1 replied.
  const states = [
    'pending_review',
    'pending_review',
    'pending_review',
    'approved',
    'approved',
    'sent',
    'replied',
  ];
  for (const state of states) {
    await db.insert(schema.drafts).values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
      state,
    });
  }
  return { campaignId: campaign.id };
}

async function seedWithTimestamps(slug: string, rows: { state: string; createdAt: Date }[]) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: `${slug}-acc` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform.id,
      name: `${slug}-c1`,
      skillSlug: 'reddit-scout',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, projectId: proj.id, trigger: 'manual', status: 'success' })
    .returning();

  for (const row of rows) {
    await db.insert(schema.drafts).values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
      state: row.state,
      createdAt: row.createdAt,
    });
  }
  return { campaignId: campaign.id };
}

describe('GET /api/analytics/funnel', () => {
  beforeEach(reset);

  it('aggregates counts matching a manual SQL query', async () => {
    const { campaignId } = await seed();

    const url = new URL(`http://localhost/api/analytics/funnel?campaign_id=${campaignId}`);
    const response = await GET({ url, locals: {} } as Parameters<typeof GET>[0]);
    const body = (await response.json()) as { stages: { stage: string; count: number }[] };

    // Manual SQL aggregation against the same dataset.
    const manual = await getDb().execute<{ state: string; count: string }>(
      sql`SELECT state, COUNT(*)::int AS count FROM drafts GROUP BY state`,
    );
    const byState = new Map<string, number>();
    for (const row of manual.rows) {
      byState.set(row.state, Number(row.count));
    }

    const stageMap = Object.fromEntries(body.stages.map((s) => [s.stage, s.count]));
    expect(stageMap.proposed).toBe(byState.get('pending_review') ?? 0);
    expect(stageMap.approved).toBe(byState.get('approved') ?? 0);
    expect(stageMap.sent).toBe(byState.get('sent') ?? 0);
    expect(stageMap.replied).toBe(byState.get('replied') ?? 0);

    // Sanity-check the seeded fixture.
    expect(stageMap.proposed).toBe(3);
    expect(stageMap.approved).toBe(2);
    expect(stageMap.sent).toBe(1);
    expect(stageMap.replied).toBe(1);
  });

  it('a range preset excludes rows older than the window and returns the smaller counts', async () => {
    const now = Date.now();
    const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

    const { campaignId } = await seedWithTimestamps('funnel-range-test', [
      { state: 'sent', createdAt: fortyDaysAgo },
      { state: 'sent', createdAt: fortyDaysAgo },
      { state: 'sent', createdAt: fortyDaysAgo },
      { state: 'sent', createdAt: oneDayAgo },
      { state: 'sent', createdAt: oneDayAgo },
    ]);

    const allTimeUrl = new URL(`http://localhost/api/analytics/funnel?campaign_id=${campaignId}`);
    const allTimeRes = await GET({ url: allTimeUrl, locals: {} } as Parameters<typeof GET>[0]);
    const allTimeBody = (await allTimeRes.json()) as { stages: { stage: string; count: number }[] };
    expect(allTimeBody.stages.find((s) => s.stage === 'sent')?.count).toBe(5);

    const rangeUrl = new URL(
      `http://localhost/api/analytics/funnel?campaign_id=${campaignId}&range=7d`,
    );
    const rangeRes = await GET({ url: rangeUrl, locals: {} } as Parameters<typeof GET>[0]);
    const rangeBody = (await rangeRes.json()) as { stages: { stage: string; count: number }[] };
    // Only the 2 rows from the last day fall inside a 7-day window; the 3
    // rows from 40 days ago are excluded, so the count shrinks accordingly.
    expect(rangeBody.stages.find((s) => s.stage === 'sent')?.count).toBe(2);
  });

  it('reports a real 0% rate for a measured denominator and omits the rate when the denominator is absent', async () => {
    const now = new Date();
    // 5 proposed, nothing beyond it: approved has a real denominator (5) and
    // zero conversions - a genuine 0%, not a missing value. Sent and replied
    // sit behind a 0-count approved stage, so their denominator is absent
    // and their rate must not be printed as a number at all.
    const { campaignId } = await seedWithTimestamps('funnel-rate-test', [
      { state: 'pending_review', createdAt: now },
      { state: 'pending_review', createdAt: now },
      { state: 'pending_review', createdAt: now },
      { state: 'pending_review', createdAt: now },
      { state: 'pending_review', createdAt: now },
    ]);

    const url = new URL(`http://localhost/api/analytics/funnel?campaign_id=${campaignId}`);
    const response = await GET({ url, locals: {} } as Parameters<typeof GET>[0]);
    const body = (await response.json()) as {
      stages: { stage: string; count: number; rate: number | null }[];
    };
    const byStage = Object.fromEntries(body.stages.map((s) => [s.stage, s]));

    // The first stage never has a prior stage to divide by.
    expect(byStage.proposed.count).toBe(5);
    expect(byStage.proposed.rate).toBeNull();

    // A real denominator (5 proposed) with zero conversions: a measured 0%,
    // must still print rather than being dropped like a missing value.
    expect(byStage.approved.count).toBe(0);
    expect(byStage.approved.rate).toBe(0);

    // Approved is itself 0, so sent (and replied, one stage further down)
    // have nothing to divide by: the rate is absent, not a bogus number.
    expect(byStage.sent.count).toBe(0);
    expect(byStage.sent.rate).toBeNull();
    expect(byStage.replied.count).toBe(0);
    expect(byStage.replied.rate).toBeNull();
  });
});
