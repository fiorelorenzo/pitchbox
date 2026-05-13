import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client.js';
import { scoreDraft, scoreBand, DEFAULT_QUALITY_RUBRIC } from '../src/quality-judge.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history RESTART IDENTITY CASCADE`,
  );
}

async function setup() {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ slug: 'qj-test', name: 'qj-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'qjuser' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'Hello there, I noticed your project and wanted to reach out with a quick idea.',
      targetUser: 'someone',
    })
    .returning();
  return { draft, db };
}

describe('quality-judge', () => {
  beforeEach(reset);

  it('persists score, reason, model and emits draft event', async () => {
    const { draft, db } = await setup();
    const res = await scoreDraft(db, draft.id);
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(100);
    expect(res.model).toBe('stub-judge-v1');

    const [persisted] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(persisted.qualityScore).toBe(res.score);
    expect(persisted.qualityReason).toContain('stub-judge');
    expect(persisted.qualityModel).toBe('stub-judge-v1');

    const events = await db
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id));
    expect(events.some((e) => e.event === 'scored')).toBe(true);
  });

  it('maps scores to UI bands using rubric thresholds', () => {
    expect(scoreBand(null, DEFAULT_QUALITY_RUBRIC)).toBe('none');
    expect(scoreBand(20, DEFAULT_QUALITY_RUBRIC)).toBe('red');
    expect(scoreBand(50, DEFAULT_QUALITY_RUBRIC)).toBe('amber');
    expect(scoreBand(90, DEFAULT_QUALITY_RUBRIC)).toBe('green');
  });
});
