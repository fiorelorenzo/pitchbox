import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  load as loadPeople,
  type PeoplePageData,
  type ContactsTabData,
} from '../src/routes/people/+page.server.js';
import { GET as loadMoreContacts } from '../src/routes/contacts/+server.js';

/**
 * Contacts used to fetch a hard `.limit(500)` and render whatever came back
 * with no way to reach anything beyond it (#228). This covers the
 * cursor-based "Load more" that replaced it: the first page comes from the
 * page loader (`load`), exactly like a real page render, and page two comes
 * from the co-located JSON endpoint (`GET` in +server.ts) the client's
 * "Load more" button now fetches instead of navigating. The cursor tuple
 * (last_contacted_at, id) stays stable even when two rows share the exact
 * same timestamp (the worst case for concurrent inserts), and appending
 * page two onto page one client-side reconstructs every row exactly once.
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
function asContactsTab(data: PeoplePageData): ContactsTabData {
  if (data.tab !== 'contacts') throw new Error('expected the contacts tab');
  return data;
}

// Seeds 49 contacts at distinct, strictly increasing timestamps plus 2 more
// that share the single newest timestamp (a stand-in for two rows inserted
// concurrently) - 51 rows total, one more than a page. Returns them in
// expected page order (newest/highest-id first).
async function seedContacts() {
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

  // Newest timestamp, shared by both rows - the tiebreaker (id) is the only
  // thing that can order them.
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

  // Expected order: id desc among the tied pair, then descending timestamp
  // for the rest.
  const tiedDesc = [...tied].sort((a, b) => b.id - a.id);
  const distinctDesc = [...inserted].sort((a, b) => b.id - a.id);
  return { all: [...tiedDesc, ...distinctDesc], total: 51 };
}

describe('contacts pagination', () => {
  beforeEach(reset);

  it('caps the first page at the page size and reports the true total', async () => {
    const orgId = await getDefaultOrgId();
    await seedContacts();

    const data = asContactsTab(await loadPeople(fakeEvent(orgId, 'http://x/people?tab=contacts')));

    expect(data.contacts).toHaveLength(PAGE_SIZE);
    expect(data.matchingCount).toBe(51);
    expect(data.nextCursor).not.toBeNull();
  });

  it('"Load more" appends page two onto page one with no duplicates and no gaps, tied timestamp included', async () => {
    const orgId = await getDefaultOrgId();
    const { all, total } = await seedContacts();

    const page1 = asContactsTab(await loadPeople(fakeEvent(orgId, 'http://x/people?tab=contacts')));
    expect(page1.contacts.map((c) => c.id)).toEqual(all.slice(0, PAGE_SIZE).map((c) => c.id));

    // Page two is what the client's "Load more" button actually fetches:
    // the co-located JSON endpoint, not the page loader.
    const cursor = page1.nextCursor!;
    const page2Url = `http://x/contacts?cursor_at=${encodeURIComponent(cursor.lastContactedAt)}&cursor_id=${cursor.id}`;
    const page2Res = await loadMoreContacts(fakeEvent(orgId, page2Url));
    const page2 = (await page2Res.json()) as {
      contacts: Array<{ id: number }>;
      matchingCount: number;
      nextCursor: { lastContactedAt: string; id: string } | null;
    };

    expect(page2.contacts).toHaveLength(total - PAGE_SIZE);
    expect(page2.nextCursor).toBeNull();
    expect(page2.contacts.map((c) => c.id)).toEqual(all.slice(PAGE_SIZE).map((c) => c.id));

    // No overlap between the two pages...
    const page1Ids = new Set(page1.contacts.map((c) => c.id));
    const page2Ids = new Set(page2.contacts.map((c) => c.id));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    expect(page1Ids.size + page2Ids.size).toBe(total);

    // ...and appending them client-side (`items = [...items, ...page2]`, the
    // exact operation the "Load more" handler performs) reconstructs the
    // full, gapless set in the right order, tied pair included.
    const appended = [...page1.contacts, ...page2.contacts].map((c) => c.id);
    expect(appended).toEqual(all.map((c) => c.id));
    expect(new Set(appended).size).toBe(total);
  });
});
