import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadProject } from '../src/routes/projects/[id]/+page.server.js';

/**
 * `?run=<id>` on the project detail page mirrors the campaign detail page's
 * deep link (#239, #259): it is meant to expand and scroll to a specific
 * extraction run on the Overview tab. A run older than the loaded page
 * window would otherwise land on the tab with nothing to highlight - no
 * crash, just a link that looks broken (this is also how a `?run=` for a
 * project-scoped run redirected off `/campaigns` now lands, since that
 * route only knows how to resolve campaign-owned runs). This covers the
 * out-of-band fetch that replaces that silent failure: a `?run=` id outside
 * the first page is fetched separately and spliced into
 * `data.extractionRuns` so the Overview tab (which expands and scrolls to
 * any row present in that array - see ProjectExtractionRunsTable.svelte)
 * can find and highlight it on first load, without the user needing to
 * click "Load more" enough times to reach it.
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

async function seedProjectWithRuns(slug: string, runCount: number) {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug })
    .returning();
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const rows = Array.from({ length: runCount }, (_, i) => ({
    projectId: project.id,
    kind: 'project_extraction' as const,
    trigger: 'manual',
    startedAt: new Date(base + i * 1000),
  }));
  const inserted = await db.insert(schema.runs).values(rows).returning();
  // Newest (highest startedAt, and highest id at a tie) first - page order.
  const runsDesc = [...inserted].sort((a, b) => b.id - a.id);
  return { orgId, projectId: project.id, runsDesc };
}

function loadEvent(
  orgId: number,
  projectId: number,
  url: string,
): Parameters<typeof loadProject>[0] {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    params: { id: String(projectId) },
    url: new URL(url),
  } as unknown as Parameters<typeof loadProject>[0];
}

describe('project Overview tab ?run= deep link resolves outside the loaded page (#259)', () => {
  beforeEach(reset);

  it('is absent from the plain first page but present once ?run= targets the 50th-most-recent run', async () => {
    const { orgId, projectId, runsDesc } = await seedProjectWithRuns('prd-a', 60);
    const target = runsDesc[49]; // 50th-most-recent, well past the 30-row window

    const withoutLink = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}`),
    )) as { extractionRuns: Array<{ id: number }>; extractionRunsTotalCount: number };
    expect(withoutLink.extractionRuns).toHaveLength(PAGE_SIZE);
    expect(withoutLink.extractionRuns.some((r) => r.id === target.id)).toBe(false);
    expect(withoutLink.extractionRunsTotalCount).toBe(60);

    const withLink = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}?run=${target.id}`),
    )) as { extractionRuns: Array<{ id: number }> };
    expect(withLink.extractionRuns.some((r) => r.id === target.id)).toBe(true);
    // The normal window is preserved alongside the one spliced-in row.
    expect(withLink.extractionRuns).toHaveLength(PAGE_SIZE + 1);
  });

  it('does not duplicate the deep-linked run when it already falls inside the first page', async () => {
    const { orgId, projectId, runsDesc } = await seedProjectWithRuns('prd-b', 60);
    const target = runsDesc[5]; // well inside the first 30, no splice needed

    const data = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}?run=${target.id}`),
    )) as { extractionRuns: Array<{ id: number }> };

    expect(data.extractionRuns).toHaveLength(PAGE_SIZE);
    expect(data.extractionRuns.filter((r) => r.id === target.id)).toHaveLength(1);
  });

  it('keeps the same silent no-highlight behaviour as the campaign page for a run id that does not exist', async () => {
    const { orgId, projectId } = await seedProjectWithRuns('prd-c', 60);
    const bogusId = 999999999;

    const data = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}?run=${bogusId}`),
    )) as { extractionRuns: Array<{ id: number }>; extractionRunsTotalCount: number };

    expect(data.extractionRuns).toHaveLength(PAGE_SIZE);
    expect(data.extractionRunsTotalCount).toBe(60);
    expect(data.extractionRuns.some((r) => r.id === bogusId)).toBe(false);
  });

  it('keeps the same silent no-highlight behaviour for a run id belonging to another project', async () => {
    const a = await seedProjectWithRuns('prd-d', 60);
    const b = await seedProjectWithRuns('prd-e', 5);
    const foreignRunId = b.runsDesc[0].id;

    const data = (await loadProject(
      loadEvent(a.orgId, a.projectId, `http://x/projects/${a.projectId}?run=${foreignRunId}`),
    )) as { extractionRuns: Array<{ id: number }> };

    expect(data.extractionRuns).toHaveLength(PAGE_SIZE);
    expect(data.extractionRuns.some((r) => r.id === foreignRunId)).toBe(false);
  });

  it('does not resolve a run of a different kind on this project (extraction history is project_extraction only)', async () => {
    const { orgId, projectId } = await seedProjectWithRuns('prd-f', 5);
    const db = getDb();
    const [otherKindRun] = await db
      .insert(schema.runs)
      .values({
        projectId,
        kind: 'project_insights',
        trigger: 'manual',
        startedAt: new Date('2026-01-05T00:00:00Z'),
      })
      .returning();

    const data = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}?run=${otherKindRun.id}`),
    )) as { extractionRuns: Array<{ id: number }> };

    expect(data.extractionRuns.some((r) => r.id === otherKindRun.id)).toBe(false);
  });

  it('does not re-splice on a "Load more" page (a non-null cursor is not a fresh page-one load)', async () => {
    const { orgId, projectId, runsDesc } = await seedProjectWithRuns('prd-g', 60);
    const cursorRow = runsDesc[PAGE_SIZE - 1];
    const target = runsDesc[49];

    const url =
      `http://x/projects/${projectId}` +
      `?run=${target.id}` +
      `&cursor_at=${encodeURIComponent(new Date(cursorRow.startedAt).toISOString())}` +
      `&cursor_id=${cursorRow.id}`;
    const data = (await loadProject(loadEvent(orgId, projectId, url))) as {
      extractionRuns: Array<{ id: number }>;
    };

    // Page two proper (rows 31-60) - the deep-linked row is naturally in
    // there already (it's row 50), so no separate splice should have added
    // a duplicate.
    expect(data.extractionRuns).toHaveLength(60 - PAGE_SIZE);
    expect(data.extractionRuns.filter((r) => r.id === target.id)).toHaveLength(1);
  });
});
