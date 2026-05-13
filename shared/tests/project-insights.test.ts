import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import { eq, sql } from 'drizzle-orm';

async function makeProject(slug: string) {
  const db = getDb();
  const [p] = await db
    .insert(schema.projects)
    .values({ slug, name: slug })
    .returning({ id: schema.projects.id });
  return p.id;
}

describe('project_insights schema', () => {
  beforeEach(async () => {
    await getDb().execute(
      sql`TRUNCATE project_insights, drafts, runs, projects RESTART IDENTITY CASCADE`,
    );
  });

  it('round-trips a summary row with evidence', async () => {
    const db = getDb();
    const pid = await makeProject('ins-test-rt');
    const [row] = await db
      .insert(schema.projectInsights)
      .values({
        projectId: pid,
        summaryMd: '# Patterns\n\n- subreddit X has 40% reply rate (draft #1)',
        evidence: { draftIds: [1, 2, 3], messageIds: [10] },
      })
      .returning();
    expect(row.id).toBeGreaterThan(0);
    expect(row.summaryMd).toContain('subreddit X');
    expect(row.evidence).toEqual({ draftIds: [1, 2, 3], messageIds: [10] });
    expect(row.generatedAt).toBeInstanceOf(Date);

    const fetched = await db
      .select()
      .from(schema.projectInsights)
      .where(eq(schema.projectInsights.projectId, pid));
    expect(fetched).toHaveLength(1);
  });

  it('emits "not enough data yet" message for projects with < 5 drafts', async () => {
    const db = getDb();
    const pid = await makeProject('ins-test-low-data');
    // No drafts inserted - simulate the playbook's gate.
    const draftCount = await db
      .select({ id: schema.drafts.id })
      .from(schema.drafts)
      .where(eq(schema.drafts.projectId, pid));
    const summaryMd =
      draftCount.length < 5
        ? 'Not enough data yet. Send at least 5 drafts before generating insights.'
        : 'TODO real summary';
    const [row] = await db
      .insert(schema.projectInsights)
      .values({
        projectId: pid,
        summaryMd,
        evidence: { reason: 'insufficient_data', draftCount: draftCount.length },
      })
      .returning();
    expect(row.summaryMd).toMatch(/Not enough data yet/);
    expect((row.evidence as { reason: string }).reason).toBe('insufficient_data');
  });
});
