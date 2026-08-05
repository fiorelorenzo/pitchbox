import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadInbox } from '../src/routes/inbox/+page.server.js';
import { GET as loadMoreInbox } from '../src/routes/inbox/+server.js';

/**
 * The inbox used to fetch a hard `.limit(200)` and render whatever came back
 * (#228). This covers the cursor-based "Load more" that replaced it: the
 * first page comes from the page loader (`load`), exactly like a real page
 * render, and every subsequent page comes from the co-located JSON endpoint
 * (`GET` in +server.ts) that the client's "Load more" button now fetches
 * instead of navigating - proving the two stay filtered identically and
 * that appending page 2 onto page 1 client-side (`[...page1, ...page2]`)
 * reconstructs the full, gapless, duplicate-free set, tied timestamps
 * included. Also covers the regression the issue was most worried about: a
 * state/kind filter must match a draft even when that draft would rank
 * outside the first page by recency alone, because filtering happens in SQL
 * before the page is cut, not in the browser afterward.
 */

const PAGE_SIZE = 50;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, blocklist, contact_history, draft_events RESTART IDENTITY CASCADE`,
  );
}

async function setupProject(slug: string) {
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
    .values({ projectId: proj.id, platformId: platform.id, handle: `bot-${slug}` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  return {
    orgId: org.id,
    projectId: proj.id,
    platformId: platform.id,
    accountId: account.id,
    runId: run.id,
  };
}

function fakeEvent(url: string): RequestEvent {
  return { url: new URL(url), locals: {} } as unknown as RequestEvent;
}

describe('inbox pagination', () => {
  beforeEach(reset);

  it('"Load more" appends page two onto page one with no duplicates and no gaps, tied timestamp included', async () => {
    const { projectId, platformId, accountId, runId } = await setupProject('inbox-page-a');
    const db = getDb();
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const rows = Array.from({ length: 49 }, (_, i) => ({
      runId,
      projectId,
      platformId,
      accountId,
      kind: 'dm',
      body: 'hello',
      targetUser: `t-${i}`,
      state: 'pending_review',
      createdAt: new Date(base + i * 1000),
    }));
    const inserted = await db.insert(schema.drafts).values(rows).returning();
    const tiedAt = new Date(base + 49 * 1000);
    const tied = await db
      .insert(schema.drafts)
      .values([
        {
          runId,
          projectId,
          platformId,
          accountId,
          kind: 'dm',
          body: 'hi',
          targetUser: 'tied-a',
          state: 'pending_review',
          createdAt: tiedAt,
        },
        {
          runId,
          projectId,
          platformId,
          accountId,
          kind: 'dm',
          body: 'hi',
          targetUser: 'tied-b',
          state: 'pending_review',
          createdAt: tiedAt,
        },
      ])
      .returning();

    const tiedDesc = [...tied].sort((a, b) => b.id - a.id);
    const distinctDesc = [...inserted].sort((a, b) => b.id - a.id);
    const expectedOrder = [...tiedDesc, ...distinctDesc].map((d) => d.id);

    const page1 = await loadInbox(fakeEvent('http://x/inbox?state=pending_review'));
    expect(page1.drafts).toHaveLength(PAGE_SIZE);
    expect(page1.totalCount).toBe(51);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.drafts.map((d: { id: number }) => d.id)).toEqual(
      expectedOrder.slice(0, PAGE_SIZE),
    );

    // Page two is what the client's "Load more" button actually fetches:
    // the co-located JSON endpoint, not the page loader.
    const cursor = page1.nextCursor!;
    const page2Url = `http://x/inbox?state=pending_review&cursor_at=${encodeURIComponent(cursor.createdAt)}&cursor_id=${cursor.id}`;
    const page2Res = await loadMoreInbox(fakeEvent(page2Url));
    const page2 = (await page2Res.json()) as {
      drafts: Array<{ id: number }>;
      nextCursor: { createdAt: string; id: string } | null;
    };
    expect(page2.drafts).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(page2.drafts.map((d) => d.id)).toEqual(expectedOrder.slice(PAGE_SIZE));

    // No overlap between the two pages...
    const page1Ids = new Set(page1.drafts.map((d: { id: number }) => d.id));
    const page2Ids = new Set(page2.drafts.map((d) => d.id));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    expect(page1Ids.size + page2Ids.size).toBe(51);

    // ...and appending them client-side (`items = [...items, ...page2]`, the
    // exact operation the "Load more" handler performs) reconstructs the
    // full, gapless set in the right order, tied pair included.
    const appended = [...page1.drafts, ...page2.drafts].map((d) => d.id);
    expect(appended).toEqual(expectedOrder);
    expect(new Set(appended).size).toBe(expectedOrder.length);
  });

  it('a kind filter still finds a draft that ranks outside the first page by recency', async () => {
    const { projectId, platformId, accountId, runId } = await setupProject('inbox-page-b');
    const db = getDb();
    const base = new Date('2026-01-01T00:00:00Z').getTime();

    // 50 recent 'dm' fillers rank ahead of the one older 'post_comment'
    // target - a plain (unfiltered) first page would never see it.
    const fillers = Array.from({ length: 50 }, (_, i) => ({
      runId,
      projectId,
      platformId,
      accountId,
      kind: 'dm',
      body: 'hello',
      targetUser: `filler-${i}`,
      state: 'pending_review',
      createdAt: new Date(base + (i + 1) * 1000),
    }));
    await db.insert(schema.drafts).values(fillers);
    const [target] = await db
      .insert(schema.drafts)
      .values({
        runId,
        projectId,
        platformId,
        accountId,
        kind: 'post_comment',
        body: 'the target',
        targetUser: 'target-user',
        state: 'pending_review',
        createdAt: new Date(base),
      })
      .returning();

    const unfiltered = await loadInbox(fakeEvent('http://x/inbox?state=pending_review'));
    expect(unfiltered.drafts).toHaveLength(PAGE_SIZE);
    expect(unfiltered.drafts.some((d: { id: number }) => d.id === target.id)).toBe(false);

    const filtered = await loadInbox(
      fakeEvent('http://x/inbox?state=pending_review&kind=post_comment'),
    );
    expect(filtered.drafts).toHaveLength(1);
    expect(filtered.drafts[0].id).toBe(target.id);
    expect(filtered.nextCursor).toBeNull();
  });
});
