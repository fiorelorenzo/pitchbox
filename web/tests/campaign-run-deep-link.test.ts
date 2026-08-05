import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadCampaign } from '../src/routes/campaigns/[id]/+page.server.js';

/**
 * `?run=<id>` (#239) is meant to expand and scroll to a specific run on the
 * campaign detail page's Runs tab. Once run history stopped being a flat
 * `.limit(30)` and became paginated (#259), a link to a run older than the
 * loaded window would otherwise land on the tab with nothing to highlight -
 * no crash, just a link that looks broken. This covers the out-of-band
 * fetch that replaces that silent failure: a `?run=` id outside the first
 * page is fetched separately and spliced into `data.runs` so the Runs tab
 * (which expands and scrolls to any row present in that array - see
 * CampaignRunsTab.svelte) can find and highlight it on first load, without
 * the user needing to click "Load more" enough times to reach it.
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

async function seedCampaignWithRuns(slug: string, runCount: number) {
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
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const rows = Array.from({ length: runCount }, (_, i) => ({
    campaignId: campaign.id,
    trigger: 'manual',
    startedAt: new Date(base + i * 1000),
  }));
  const inserted = await db.insert(schema.runs).values(rows).returning();
  // Newest (highest startedAt, and highest id at a tie) first - page order.
  const runsDesc = [...inserted].sort((a, b) => b.id - a.id);
  return { orgId, campaignId: campaign.id, runsDesc };
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

describe('campaign Runs tab ?run= deep link resolves outside the loaded page (#259)', () => {
  beforeEach(reset);

  it('is absent from the plain first page but present once ?run= targets the 50th-most-recent run', async () => {
    const { orgId, campaignId, runsDesc } = await seedCampaignWithRuns('crd-a', 60);
    const target = runsDesc[49]; // 50th-most-recent, well past the 30-row window

    const withoutLink = (await loadCampaign(
      loadEvent(orgId, campaignId, `http://x/campaigns/${campaignId}`),
    )) as { runs: Array<{ id: number }>; runsTotalCount: number };
    expect(withoutLink.runs).toHaveLength(PAGE_SIZE);
    expect(withoutLink.runs.some((r) => r.id === target.id)).toBe(false);
    expect(withoutLink.runsTotalCount).toBe(60);

    const withLink = (await loadCampaign(
      loadEvent(orgId, campaignId, `http://x/campaigns/${campaignId}?run=${target.id}`),
    )) as { runs: Array<{ id: number }> };
    expect(withLink.runs.some((r) => r.id === target.id)).toBe(true);
    // The normal window is preserved alongside the one spliced-in row.
    expect(withLink.runs).toHaveLength(PAGE_SIZE + 1);
  });

  it('does not duplicate the deep-linked run when it already falls inside the first page', async () => {
    const { orgId, campaignId, runsDesc } = await seedCampaignWithRuns('crd-b', 60);
    const target = runsDesc[5]; // well inside the first 30, no splice needed

    const data = (await loadCampaign(
      loadEvent(orgId, campaignId, `http://x/campaigns/${campaignId}?run=${target.id}`),
    )) as { runs: Array<{ id: number }> };

    expect(data.runs).toHaveLength(PAGE_SIZE);
    expect(data.runs.filter((r) => r.id === target.id)).toHaveLength(1);
  });

  it('keeps the existing silent no-highlight behaviour for a run id that does not exist', async () => {
    const { orgId, campaignId } = await seedCampaignWithRuns('crd-c', 60);
    const bogusId = 999999999;

    const data = (await loadCampaign(
      loadEvent(orgId, campaignId, `http://x/campaigns/${campaignId}?run=${bogusId}`),
    )) as { runs: Array<{ id: number }>; runsTotalCount: number };

    expect(data.runs).toHaveLength(PAGE_SIZE);
    expect(data.runsTotalCount).toBe(60);
    expect(data.runs.some((r) => r.id === bogusId)).toBe(false);
  });

  it('keeps the existing silent no-highlight behaviour for a run id belonging to another campaign', async () => {
    const a = await seedCampaignWithRuns('crd-d', 60);
    const b = await seedCampaignWithRuns('crd-e', 5);
    const foreignRunId = b.runsDesc[0].id;

    const data = (await loadCampaign(
      loadEvent(a.orgId, a.campaignId, `http://x/campaigns/${a.campaignId}?run=${foreignRunId}`),
    )) as { runs: Array<{ id: number }> };

    expect(data.runs).toHaveLength(PAGE_SIZE);
    expect(data.runs.some((r) => r.id === foreignRunId)).toBe(false);
  });

  it('does not re-splice on a "Load more" page (a non-null cursor is not a fresh page-one load)', async () => {
    const { orgId, campaignId, runsDesc } = await seedCampaignWithRuns('crd-f', 60);
    const cursorRow = runsDesc[PAGE_SIZE - 1];
    const target = runsDesc[49];

    const url =
      `http://x/campaigns/${campaignId}` +
      `?run=${target.id}` +
      `&cursor_at=${encodeURIComponent(new Date(cursorRow.startedAt).toISOString())}` +
      `&cursor_id=${cursorRow.id}`;
    const data = (await loadCampaign(loadEvent(orgId, campaignId, url))) as {
      runs: Array<{ id: number }>;
    };

    // Page two proper (rows 31-60) - the deep-linked row is naturally in
    // there already (it's row 50), so no separate splice should have added
    // a duplicate.
    expect(data.runs).toHaveLength(60 - PAGE_SIZE);
    expect(data.runs.filter((r) => r.id === target.id)).toHaveLength(1);
  });
});
