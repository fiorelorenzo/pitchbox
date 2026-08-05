import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  load as loadPeople,
  type PeoplePageData,
  type ThreadsTabData,
} from '../src/routes/people/+page.server.js';
import { GET as loadMoreConversations } from '../src/routes/conversations/+server.js';

/**
 * Conversations used to fetch a hard `.limit(200)` and then filter/search
 * client-side over whatever came back (#228) - so a search could report "no
 * matches" while a matching conversation sat just outside the fetched
 * window. This covers the cursor-based "Load more" that replaced the limit:
 * the first page comes from the page loader (`load`), exactly like a real
 * page render, and page two comes from the co-located JSON endpoint (`GET`
 * in +server.ts) the client's "Load more" button now fetches instead of
 * navigating, appending onto page one with no duplicates or gaps. Also
 * covers the correctness fix: filtering (including the message-body
 * search) now runs in SQL before the page is cut, so it always sees the
 * whole table.
 */

const PAGE_SIZE = 50;

async function reset() {
  await getDb().execute(
    sql`TRUNCATE messages, contact_history, drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

async function getDefaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

async function setupProject(orgId: number, slug: string) {
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
  return { projectId: project.id, platformId: platform.id, accountId: account.id, runId: run.id };
}

function fakeEvent(orgId: number, url: string): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL(url),
    params: {},
  } as unknown as RequestEvent;
}

// `/people`'s loader returns a discriminated union keyed on `tab`
// (contacts-shaped vs. threads-shaped data - see +page.server.ts); narrow
// on the real discriminant rather than asserting the whole result.
function asThreadsTab(data: PeoplePageData): ThreadsTabData {
  if (data.tab !== 'threads') throw new Error('expected the threads tab');
  return data;
}

describe('conversations pagination', () => {
  beforeEach(reset);

  it('"Load more" appends page two onto page one with no duplicates and no gaps, tied timestamp included', async () => {
    const orgId = await getDefaultOrgId();
    const db = getDb();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const base = new Date('2026-01-01T00:00:00Z').getTime();

    const distinctRows = Array.from({ length: 49 }, (_, i) => ({
      platformId: platform.id,
      accountHandle: 'bot',
      targetUser: `t-${i}`,
      lastContactedAt: new Date(base + i * 1000),
    }));
    const inserted = await db.insert(schema.contactHistory).values(distinctRows).returning();
    const tiedAt = new Date(base + 49 * 1000);
    const tied = await db
      .insert(schema.contactHistory)
      .values([
        {
          platformId: platform.id,
          accountHandle: 'bot',
          targetUser: 'tied-a',
          lastContactedAt: tiedAt,
        },
        {
          platformId: platform.id,
          accountHandle: 'bot',
          targetUser: 'tied-b',
          lastContactedAt: tiedAt,
        },
      ])
      .returning();

    const tiedDesc = [...tied].sort((a, b) => b.id - a.id);
    const distinctDesc = [...inserted].sort((a, b) => b.id - a.id);
    const expectedOrder = [...tiedDesc, ...distinctDesc].map((c) => c.id);

    const page1 = asThreadsTab(await loadPeople(fakeEvent(orgId, 'http://x/people')));
    expect(page1.conversations).toHaveLength(PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.conversations.map((c) => c.contactId)).toEqual(expectedOrder.slice(0, PAGE_SIZE));

    // Page two is what the client's "Load more" button actually fetches:
    // the co-located JSON endpoint, not the page loader.
    const cursor = page1.nextCursor!;
    const page2Url = `http://x/conversations?cursor_at=${encodeURIComponent(cursor.sortAt)}&cursor_id=${cursor.id}`;
    const page2Res = await loadMoreConversations(fakeEvent(orgId, page2Url));
    const page2 = (await page2Res.json()) as {
      conversations: Array<{ contactId: number }>;
      nextCursor: { sortAt: string; id: string } | null;
    };
    expect(page2.conversations).toHaveLength(51 - PAGE_SIZE);
    expect(page2.nextCursor).toBeNull();
    expect(page2.conversations.map((c) => c.contactId)).toEqual(expectedOrder.slice(PAGE_SIZE));

    // No overlap between the two pages...
    const page1Ids = new Set(page1.conversations.map((c) => c.contactId));
    const page2Ids = new Set(page2.conversations.map((c) => c.contactId));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    expect(page1Ids.size + page2Ids.size).toBe(51);

    // ...and appending them client-side (`items = [...items, ...page2]`, the
    // exact operation the "Load more" handler performs) reconstructs the
    // full, gapless set in the right order, tied pair included.
    const appended = [...page1.conversations, ...page2.conversations].map((c) => c.contactId);
    expect(appended).toEqual(expectedOrder);
    expect(new Set(appended).size).toBe(expectedOrder.length);
  });

  it('a message-body search finds a conversation that ranks outside the first page by recency', async () => {
    const orgId = await getDefaultOrgId();
    const { projectId, platformId, accountId, runId } = await setupProject(orgId, 'conv-page-b');
    const db = getDb();
    const base = new Date('2026-01-01T00:00:00Z').getTime();

    // 50 recent fillers with no messages rank ahead of the one older target -
    // an unfiltered first page would never reach it.
    const fillers = Array.from({ length: 50 }, (_, i) => ({
      platformId,
      accountHandle: 'bot',
      targetUser: `filler-${i}`,
      lastContactedAt: new Date(base + (i + 1) * 1000),
    }));
    await db.insert(schema.contactHistory).values(fillers);

    const [draft] = await db
      .insert(schema.drafts)
      .values({
        runId,
        projectId,
        platformId,
        accountId,
        kind: 'dm',
        state: 'sent',
        targetUser: 'target-user',
        body: 'target draft body',
      })
      .returning();
    const [targetContact] = await db
      .insert(schema.contactHistory)
      .values({
        platformId,
        accountHandle: 'target-acc',
        targetUser: 'target-user',
        draftId: draft.id,
        lastContactedAt: new Date(base),
      })
      .returning();
    await db.insert(schema.messages).values({
      contactId: targetContact.id,
      draftId: draft.id,
      platformId,
      author: 'target-acc',
      isFromUs: true,
      body: 'a very distinctive needle phrase',
      platformMessageId: 'm-target-1',
      createdAtPlatform: new Date(base),
      source: 'test',
    });

    const unfiltered = asThreadsTab(await loadPeople(fakeEvent(orgId, 'http://x/people')));
    expect(unfiltered.conversations).toHaveLength(PAGE_SIZE);
    expect(unfiltered.conversations.some((c) => c.contactId === targetContact.id)).toBe(false);

    const searched = asThreadsTab(
      await loadPeople(fakeEvent(orgId, 'http://x/people?q=distinctive+needle')),
    );
    expect(searched.conversations).toHaveLength(1);
    expect(searched.conversations[0].contactId).toBe(targetContact.id);
    expect(searched.nextCursor).toBeNull();
  });
});
