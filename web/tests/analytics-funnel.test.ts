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
});
