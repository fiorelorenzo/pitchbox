import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, schema } from '@pitchbox/shared/db';
import type { AuditRow } from '../src/lib/server/audit-feed.js';
import { load as loadAudit } from '../src/routes/audit/+page.server.js';
import { GET as loadMoreAudit } from '../src/routes/audit/+server.js';

/**
 * `/audit`'s "Load more" used to `goto()` to a cursor URL, replacing the
 * visible rows instead of appending to them - the defect this file was
 * written to close (fixed identically across /audit, /inbox, /contacts and
 * /conversations). This covers the fetch-based replacement: the first page
 * comes from the page loader (`load`), exactly like a real page render, and
 * page two comes from the co-located JSON endpoint (`GET` in +server.ts)
 * the client's "Load more" button now fetches instead of navigating.
 * Appending page two onto page one client-side reconstructs the full,
 * gapless, duplicate-free set - including tied timestamps that straddle a
 * digit-length boundary, the same worst case the /inbox, /contacts and
 * /conversations pagination tests fixture.
 *
 * That boundary case matters here specifically: `loadAuditFeed`'s cursor
 * used to compare `id` as `::text` (needed to give `draft_events` and
 * `run_events` rows a shared column type for the UNION), which made ties
 * break lexicographically instead of numerically ("99" sorts after "100")
 * - and, worse, made the cursor's `(created_at, id) < (…, id::bigint)`
 * predicate a text/bigint comparison Postgres flatly rejects, so every
 * "Load more" past page one 500'd. `id` is a native bigint in the CTE now;
 * this fixture seeds two tied pairs (ids 9/10 and 99/100) specifically so
 * a reintroduced `::text` cast - order or predicate - fails this test
 * instead of failing silently in production.
 */

const PAGE_SIZE = 100;

async function reset() {
  // Non-default orgs first, so their cascade wipes the rows a plain TRUNCATE
  // of the shared tables below would otherwise leave behind.
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events, run_events RESTART IDENTITY CASCADE`,
  );
}

async function getDefaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

async function setupDraft(orgId: number, slug: string): Promise<number> {
  const db = getDb();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: project.id, platformId: platform.id, handle: `${slug}-acc` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: project.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: project.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
      state: 'pending_review',
    })
    .returning();
  return draft.id;
}

// `loadAudit` is typed via the generated `PageServerLoad` (a `ServerLoadEvent`
// scoped to `/audit`'s own params/parent-data, stricter than the plain
// `RequestEvent` the `+server.ts` `GET` handler takes), so build the fake
// event with the callee's own inferred parameter type rather than a single
// shared `RequestEvent`, matching route-guards-detail-pages.test.ts.
function fakeEvent<T extends (event: never) => unknown>(
  orgId: number,
  url: string,
): Parameters<T>[0] {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL(url),
    params: {},
  } as unknown as Parameters<T>[0];
}

// The loader's declared return type always includes `void` (svelte-kit's
// generated `PageServerLoad` default `OutputData`, unrelated to any
// redirect - this loader never throws one), so narrow it once here to what
// the loader actually returns (see `+page.server.ts`) instead of asserting
// per field below.
type AuditPageResult = {
  rows: Array<Omit<AuditRow, 'createdAt'> & { createdAt: string }>;
  nextCursor: { createdAt: string; id: string } | null;
};

// Seeds 101 draft_events - one more than a page - with two tied pairs placed
// so their ids straddle a digit-length boundary: (9, 10) and (99, 100). Under
// a correct numeric id comparison the tie always resolves higher-id-first,
// same as if the pair had distinct timestamps a moment apart - so the full
// order is simply descending id, 101 down to 1. Under a lexicographic (text)
// comparison "9" sorts after "10" and "99" sorts after "100", which would
// misorder exactly these two pairs and fail the assertions below.
async function seedBoundaryFixture(orgId: number) {
  const db = getDb();
  const draftId = await setupDraft(orgId, 'audit-page-boundary');
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const slot = (n: number) => new Date(base + n * 1000);

  // ids 1-8: distinct, oldest.
  await db.insert(schema.draftEvents).values(
    Array.from({ length: 8 }, (_, i) => ({
      draftId,
      event: 'e',
      actor: 'user-1',
      details: {},
      createdAt: slot(i),
    })),
  );
  // ids 9-10: tied - straddles the single/double digit boundary.
  await db.insert(schema.draftEvents).values([
    { draftId, event: 'tied-lo-a', actor: 'user-1', details: {}, createdAt: slot(8) },
    { draftId, event: 'tied-lo-b', actor: 'user-1', details: {}, createdAt: slot(8) },
  ]);
  // ids 11-98: distinct, strictly increasing.
  await db.insert(schema.draftEvents).values(
    Array.from({ length: 88 }, (_, i) => ({
      draftId,
      event: 'e',
      actor: 'user-1',
      details: {},
      createdAt: slot(9 + i),
    })),
  );
  // ids 99-100: tied - straddles the double/triple digit boundary.
  await db.insert(schema.draftEvents).values([
    { draftId, event: 'tied-hi-a', actor: 'user-1', details: {}, createdAt: slot(97) },
    { draftId, event: 'tied-hi-b', actor: 'user-1', details: {}, createdAt: slot(97) },
  ]);
  // id 101: newest, alone.
  await db
    .insert(schema.draftEvents)
    .values([{ draftId, event: 'newest', actor: 'user-1', details: {}, createdAt: slot(98) }]);

  // Ids are assigned sequentially by the statements above (RESTART IDENTITY
  // in `reset()`), so the correct order is exactly descending id, 101..1.
  return Array.from({ length: 101 }, (_, i) => String(101 - i));
}

describe('audit pagination', () => {
  beforeEach(reset);

  it('"Load more" appends page two onto page one with no duplicates and no gaps, across a tied digit-boundary id', async () => {
    const defaultOrgId = await getDefaultOrgId();
    const expectedOrder = await seedBoundaryFixture(defaultOrgId);

    const page1 = (await loadAudit(
      fakeEvent<typeof loadAudit>(defaultOrgId, 'http://x/audit'),
    )) as AuditPageResult;
    expect(page1.rows).toHaveLength(PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.rows.map((r) => r.id)).toEqual(expectedOrder.slice(0, PAGE_SIZE));

    // Page two is what the client's "Load more" button actually fetches:
    // the co-located JSON endpoint, not the page loader. This is also the
    // request shape that used to 500 (see the file-level comment): a text
    // `id` column compared against `id::bigint` in the cursor predicate.
    const cursor = page1.nextCursor!;
    const page2Url = `http://x/audit?cursor_at=${encodeURIComponent(cursor.createdAt)}&cursor_id=${cursor.id}`;
    const page2Res = await loadMoreAudit(fakeEvent<typeof loadMoreAudit>(defaultOrgId, page2Url));
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      rows: Array<{ id: string }>;
      nextCursor: { createdAt: string; id: string } | null;
    };
    expect(page2.rows).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(page2.rows.map((r) => r.id)).toEqual(expectedOrder.slice(PAGE_SIZE));

    // No overlap between the two pages...
    const page1Ids = new Set(page1.rows.map((r) => r.id));
    const page2Ids = new Set(page2.rows.map((r) => r.id));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    expect(page1Ids.size + page2Ids.size).toBe(101);

    // ...and appending them client-side (`items = [...items, ...page2]`, the
    // exact operation the "Load more" handler performs) reconstructs the
    // full, gapless set in the right order - both tied pairs resolved
    // higher-id-first, exactly as a numeric comparison requires.
    const appended = [...page1.rows, ...page2.rows].map((r) => r.id);
    expect(appended).toEqual(expectedOrder);
    expect(new Set(appended).size).toBe(expectedOrder.length);
  });
});
