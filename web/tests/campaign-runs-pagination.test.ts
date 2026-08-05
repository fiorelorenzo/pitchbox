import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadCampaign } from '../src/routes/campaigns/[id]/+page.server.js';
import { GET as loadMoreCampaignRuns } from '../src/routes/campaigns/[id]/+server.js';

/**
 * The campaign detail page's Runs tab used to fetch a hard `.limit(30)` with
 * no way to reach anything beyond it and no indication a cap even existed
 * (#259, the half of #228 that was scoped out as secondary). This covers
 * the cursor-based "Load more" that replaced it: the first page comes from
 * the page loader (`load`), exactly like a real page render, and page two
 * comes from the co-located JSON endpoint (`GET` in +server.ts) the Runs
 * tab's "Load more" button now fetches instead of navigating - appending
 * onto page one with no duplicates or gaps, cursor tuple (started_at, id)
 * stable even when two runs share the exact same timestamp.
 */

const PAGE_SIZE = 30;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function getDefaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

async function seedCampaign(slug: string) {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: slug,
      skillSlug: 'reddit-scout',
    })
    .returning();
  return { orgId, campaignId: campaign.id };
}

// Seeds 29 runs at distinct, strictly increasing timestamps plus 2 more that
// share the single newest timestamp (a stand-in for two runs dispatched in
// the same scheduler tick) - 31 rows total, one more than a page. Returns
// them in expected page order (newest/highest-id first).
async function seedRuns(campaignId: number) {
  const db = getDb();
  const base = new Date('2026-01-01T00:00:00Z').getTime();

  const distinctRows = Array.from({ length: 29 }, (_, i) => ({
    campaignId,
    trigger: 'manual',
    startedAt: new Date(base + i * 1000),
  }));
  const inserted = await db.insert(schema.runs).values(distinctRows).returning();

  const tiedAt = new Date(base + 29 * 1000);
  const tied = await db
    .insert(schema.runs)
    .values([
      { campaignId, trigger: 'manual', startedAt: tiedAt },
      { campaignId, trigger: 'manual', startedAt: tiedAt },
    ])
    .returning();

  const tiedDesc = [...tied].sort((a, b) => b.id - a.id);
  const distinctDesc = [...inserted].sort((a, b) => b.id - a.id);
  return { all: [...tiedDesc, ...distinctDesc], total: 31 };
}

function loadEvent(
  orgId: number,
  campaignId: number,
  url: string,
): Parameters<typeof loadCampaign>[0] {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    params: { id: String(campaignId) },
    url: new URL(url),
  } as unknown as Parameters<typeof loadCampaign>[0];
}

function serverEvent(orgId: number, campaignId: number, url: string): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    params: { id: String(campaignId) },
    url: new URL(url),
  } as unknown as RequestEvent;
}

describe('campaign run history pagination', () => {
  beforeEach(reset);

  it('caps the first page at the page size and reports the true total', async () => {
    const { orgId, campaignId } = await seedCampaign('crp-a');
    await seedRuns(campaignId);

    const data = (await loadCampaign(
      loadEvent(orgId, campaignId, `http://x/campaigns/${campaignId}`),
    )) as {
      runs: Array<{ id: number }>;
      runsTotalCount: number;
      runsNextCursor: unknown;
    };

    expect(data.runs).toHaveLength(PAGE_SIZE);
    expect(data.runsTotalCount).toBe(31);
    expect(data.runsNextCursor).not.toBeNull();
  });

  it('"Load more" appends page two onto page one with no duplicates and no gaps, tied timestamp included', async () => {
    const { orgId, campaignId } = await seedCampaign('crp-b');
    const { all, total } = await seedRuns(campaignId);

    const page1 = (await loadCampaign(
      loadEvent(orgId, campaignId, `http://x/campaigns/${campaignId}`),
    )) as {
      runs: Array<{ id: number }>;
      runsNextCursor: { startedAt: string; id: string } | null;
    };
    expect(page1.runs.map((r) => r.id)).toEqual(all.slice(0, PAGE_SIZE).map((r) => r.id));

    // Page two is what the Runs tab's "Load more" button actually fetches:
    // the co-located JSON endpoint, not the page loader.
    const cursor = page1.runsNextCursor!;
    const page2Url = `http://x/campaigns/${campaignId}?cursor_at=${encodeURIComponent(cursor.startedAt)}&cursor_id=${cursor.id}`;
    const page2Res = await loadMoreCampaignRuns(serverEvent(orgId, campaignId, page2Url));
    const page2 = (await page2Res.json()) as {
      runs: Array<{ id: number }>;
      totalCount: number;
      nextCursor: { startedAt: string; id: string } | null;
    };

    expect(page2.runs).toHaveLength(total - PAGE_SIZE);
    expect(page2.nextCursor).toBeNull();
    expect(page2.totalCount).toBe(total);
    expect(page2.runs.map((r) => r.id)).toEqual(all.slice(PAGE_SIZE).map((r) => r.id));

    // No overlap between the two pages...
    const page1Ids = new Set(page1.runs.map((r) => r.id));
    const page2Ids = new Set(page2.runs.map((r) => r.id));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    expect(page1Ids.size + page2Ids.size).toBe(total);

    // ...and appending them client-side (`items = [...items, ...page2]`, the
    // exact operation the "Load more" handler performs) reconstructs the
    // full, gapless set in the right order, tied pair included.
    const appended = [...page1.runs, ...page2.runs].map((r) => r.id);
    expect(appended).toEqual(all.map((r) => r.id));
    expect(new Set(appended).size).toBe(total);
  });

  it('rejects a campaign owned by another org with 404, even with cursor params set', async () => {
    const { campaignId } = await seedCampaign('crp-c');
    const otherOrgEvent = serverEvent(
      999999,
      campaignId,
      `http://x/campaigns/${campaignId}?cursor_at=2026-01-01T00:00:00.000Z&cursor_id=1`,
    );
    await expect(loadMoreCampaignRuns(otherOrgEvent)).rejects.toMatchObject({ status: 404 });
  });
});
