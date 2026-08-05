import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadProject } from '../src/routes/projects/[id]/+page.server.js';
import { GET as loadMoreProjectRuns } from '../src/routes/projects/[id]/+server.js';

/**
 * The project detail page's extraction history table used to fetch a hard
 * `.limit(30)` with no way to reach anything beyond it and no indication a
 * cap even existed (#259, the other half of #228's secondary scope). This
 * covers the cursor-based "Load more" that replaced it: the first page
 * comes from the page loader (`load`), exactly like a real page render, and
 * page two comes from the co-located JSON endpoint (`GET` in +server.ts)
 * the table's "Load more" button now fetches instead of navigating -
 * appending onto page one with no duplicates or gaps, cursor tuple
 * (started_at, id) stable even when two runs share the exact same
 * timestamp. Also covers the kind filter staying in place: a
 * `project_insights` run for the same project must never leak into either
 * page (the extraction history is `project_extraction` only).
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

async function seedProject(slug: string) {
  const db = getDb();
  const orgId = await getDefaultOrgId();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug })
    .returning();
  return { orgId, projectId: project.id };
}

// Seeds 29 project_extraction runs at distinct, strictly increasing
// timestamps plus 2 more that share the single newest timestamp (a
// stand-in for two runs dispatched at once), plus one project_insights run
// at the very newest timestamp that must never appear in either page - 31
// project_extraction rows total, one more than a page. Returns the
// project_extraction rows in expected page order (newest/highest-id
// first).
async function seedRuns(projectId: number) {
  const db = getDb();
  const base = new Date('2026-01-01T00:00:00Z').getTime();

  const distinctRows = Array.from({ length: 29 }, (_, i) => ({
    projectId,
    kind: 'project_extraction' as const,
    trigger: 'manual',
    startedAt: new Date(base + i * 1000),
  }));
  const inserted = await db.insert(schema.runs).values(distinctRows).returning();

  const tiedAt = new Date(base + 29 * 1000);
  const tied = await db
    .insert(schema.runs)
    .values([
      { projectId, kind: 'project_extraction' as const, trigger: 'manual', startedAt: tiedAt },
      { projectId, kind: 'project_extraction' as const, trigger: 'manual', startedAt: tiedAt },
    ])
    .returning();

  // A same-project, different-kind run at the newest timestamp - must never
  // leak into the extraction history.
  await db
    .insert(schema.runs)
    .values({ projectId, kind: 'project_insights', trigger: 'manual', startedAt: tiedAt });

  const tiedDesc = [...tied].sort((a, b) => b.id - a.id);
  const distinctDesc = [...inserted].sort((a, b) => b.id - a.id);
  return { all: [...tiedDesc, ...distinctDesc], total: 31 };
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

function serverEvent(orgId: number, projectId: number, url: string): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    params: { id: String(projectId) },
    url: new URL(url),
  } as unknown as RequestEvent;
}

describe('project extraction run history pagination', () => {
  beforeEach(reset);

  it('caps the first page at the page size, excludes other run kinds, and reports the true total', async () => {
    const { orgId, projectId } = await seedProject('prp-a');
    await seedRuns(projectId);

    const data = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}`),
    )) as {
      extractionRuns: Array<{ id: number }>;
      extractionRunsTotalCount: number;
      extractionRunsNextCursor: unknown;
    };

    expect(data.extractionRuns).toHaveLength(PAGE_SIZE);
    expect(data.extractionRunsTotalCount).toBe(31);
    expect(data.extractionRunsNextCursor).not.toBeNull();
  });

  it('"Load more" appends page two onto page one with no duplicates and no gaps, tied timestamp included', async () => {
    const { orgId, projectId } = await seedProject('prp-b');
    const { all, total } = await seedRuns(projectId);

    const page1 = (await loadProject(
      loadEvent(orgId, projectId, `http://x/projects/${projectId}`),
    )) as {
      extractionRuns: Array<{ id: number }>;
      extractionRunsNextCursor: { startedAt: string; id: string } | null;
    };
    expect(page1.extractionRuns.map((r) => r.id)).toEqual(all.slice(0, PAGE_SIZE).map((r) => r.id));

    // Page two is what the table's "Load more" button actually fetches: the
    // co-located JSON endpoint, not the page loader.
    const cursor = page1.extractionRunsNextCursor!;
    const page2Url = `http://x/projects/${projectId}?cursor_at=${encodeURIComponent(cursor.startedAt)}&cursor_id=${cursor.id}`;
    const page2Res = await loadMoreProjectRuns(serverEvent(orgId, projectId, page2Url));
    const page2 = (await page2Res.json()) as {
      runs: Array<{ id: number }>;
      totalCount: number;
      nextCursor: { startedAt: string; id: string } | null;
    };

    expect(page2.runs).toHaveLength(total - PAGE_SIZE);
    expect(page2.nextCursor).toBeNull();
    expect(page2.totalCount).toBe(total);
    expect(page2.runs.map((r) => r.id)).toEqual(all.slice(PAGE_SIZE).map((r) => r.id));

    const page1Ids = new Set(page1.extractionRuns.map((r) => r.id));
    const page2Ids = new Set(page2.runs.map((r) => r.id));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    expect(page1Ids.size + page2Ids.size).toBe(total);

    const appended = [...page1.extractionRuns, ...page2.runs].map((r) => r.id);
    expect(appended).toEqual(all.map((r) => r.id));
    expect(new Set(appended).size).toBe(total);
  });

  it('rejects a project owned by another org with 404, even with cursor params set', async () => {
    const { projectId } = await seedProject('prp-c');
    const otherOrgEvent = serverEvent(
      999999,
      projectId,
      `http://x/projects/${projectId}?cursor_at=2026-01-01T00:00:00.000Z&cursor_id=1`,
    );
    await expect(loadMoreProjectRuns(otherOrgEvent)).rejects.toMatchObject({ status: 404 });
  });
});
