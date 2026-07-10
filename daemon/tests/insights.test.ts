import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { tick } from '../src/insights.js';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE project_insights, drafts, runs, campaigns, accounts, projects, messages, contact_history RESTART IDENTITY CASCADE`,
  );
}

async function seedProject(slug: string) {
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
    .values({ projectId: proj.id, platformId: platform.id, handle: `${slug}-acct` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 'reddit-scout' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  return { proj, platform, account, run };
}

async function addDrafts(
  ctx: Awaited<ReturnType<typeof seedProject>>,
  count: number,
  createdAt: Date,
) {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    await db.insert(schema.drafts).values({
      runId: ctx.run.id,
      projectId: ctx.proj.id,
      platformId: ctx.platform.id,
      accountId: ctx.account.id,
      kind: 'dm',
      body: `draft ${i}`,
      targetUser: `u${i}`,
      state: 'pending_review',
      createdAt,
    });
  }
}

describe('insights worker tick', () => {
  beforeEach(reset);

  it('dispatches only eligible projects (recent activity, >=5 drafts, no fresh insight)', async () => {
    const now = new Date('2026-07-08T12:00:00Z');
    const recent = new Date(now.getTime() - 60 * 60_000); // 1h ago
    const old = new Date(now.getTime() - 48 * 60 * 60_000); // 48h ago

    // A: eligible
    const a = await seedProject('proj-a');
    await addDrafts(a, 5, recent);

    // B: fresh insight -> skipped
    const b = await seedProject('proj-b');
    await addDrafts(b, 5, recent);
    await getDb()
      .insert(schema.projectInsights)
      .values({
        projectId: b.proj.id,
        summaryMd: 'x',
        generatedAt: new Date(now.getTime() - 2 * 60 * 60_000), // 2h ago (fresh)
      });

    // C: <5 drafts -> skipped
    const c = await seedProject('proj-c');
    await addDrafts(c, 3, recent);

    // D: no recent activity -> not a candidate
    const d = await seedProject('proj-d');
    await addDrafts(d, 5, old);

    const triggerRun = vi.fn(async (_projectId: number) => true);
    const res = await tick(triggerRun, () => now);

    const dispatchedIds = triggerRun.mock.calls.map((c) => c[0]).sort((x, y) => x - y);
    expect(dispatchedIds).toEqual([a.proj.id]);
    expect(res.dispatched).toBe(1);
    // A, B, C are candidates (recent draft activity); D is not.
    expect(res.checked).toBe(3);
    expect(res.skipped).toBe(2);
  });
});
