import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  load as loadPeople,
  type PeoplePageData,
  type ContactsTabData,
  type ThreadsTabData,
} from '../src/routes/people/+page.server.js';
import { load as loadContactsRedirect } from '../src/routes/contacts/+page.server.js';
import { load as loadConversationsRedirect } from '../src/routes/conversations/+page.server.js';
import { GET as loadMoreContacts } from '../src/routes/contacts/+server.js';
import { GET as loadMoreConversations } from '../src/routes/conversations/+server.js';

/**
 * #252: /contacts and /conversations merged into one /people destination
 * with two URL-driven tabs ("Threads" default, "All contacts" second).
 * This covers the parts specific to the merge - the underlying pagination
 * correctness for each tab is already covered by contacts-pagination.test.ts
 * and conversations-pagination.test.ts against the same, unduplicated query
 * modules (`contacts-query.ts` / `conversations-query.ts`) this loader
 * calls directly.
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
function asThreadsTab(data: PeoplePageData): ThreadsTabData {
  if (data.tab !== 'threads') throw new Error('expected the threads tab');
  return data;
}
function asContactsTab(data: PeoplePageData): ContactsTabData {
  if (data.tab !== 'contacts') throw new Error('expected the contacts tab');
  return data;
}

// Seeds 49 contacts at distinct, strictly increasing timestamps plus 2 more
// that share the single newest timestamp - 51 rows total, one more than a
// page. A plain contact_history row (no messages) is exactly what both
// tabs' pagination tests already seed with, since both tabs page the same
// underlying table. Returns rows in expected page order (newest/highest-id
// first).
async function seedRows() {
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
  return { all: [...tiedDesc, ...distinctDesc], total: 51 };
}

describe('People merge (#252)', () => {
  beforeEach(reset);

  it('old /contacts and /conversations URLs still resolve, redirecting to /people with every query param preserved', async () => {
    const orgId = await getDefaultOrgId();

    // Contacts becomes the secondary tab: the redirect adds `tab=contacts`
    // on top of whatever else the old URL carried.
    await expect(
      loadContactsRedirect(fakeEvent(orgId, 'http://x/contacts?platform=reddit&q=foo')),
    ).rejects.toMatchObject({
      status: 307,
      location: '/people?platform=reddit&q=foo&tab=contacts',
    });

    // Conversations maps to the default tab: the redirect carries filter/
    // kind/q across untouched, with no `tab` param added.
    await expect(
      loadConversationsRedirect(
        fakeEvent(orgId, 'http://x/conversations?filter=replied&kind=dm&q=bar'),
      ),
    ).rejects.toMatchObject({ status: 307, location: '/people?filter=replied&kind=dm&q=bar' });
  });

  it('?tab= selects the right tab, defaulting to Threads', async () => {
    const orgId = await getDefaultOrgId();
    await seedRows();

    const threads = await loadPeople(fakeEvent(orgId, 'http://x/people'));
    expect(threads.tab).toBe('threads');
    expect('conversations' in threads).toBe(true);
    expect('contacts' in threads).toBe(false);

    const contacts = await loadPeople(fakeEvent(orgId, 'http://x/people?tab=contacts'));
    expect(contacts.tab).toBe('contacts');
    expect('contacts' in contacts).toBe(true);
    expect('conversations' in contacts).toBe(false);
  });

  it('serves both tabs off the same underlying rows, each with its own count and empty-state fields', async () => {
    const orgId = await getDefaultOrgId();
    const { total } = await seedRows();

    const threads = asThreadsTab(await loadPeople(fakeEvent(orgId, 'http://x/people')));
    expect(threads.conversations).toHaveLength(PAGE_SIZE);
    expect(threads.counts.all).toBe(total);
    expect(threads.nextCursor).not.toBeNull();

    const contacts = asContactsTab(
      await loadPeople(fakeEvent(orgId, 'http://x/people?tab=contacts')),
    );
    expect(contacts.contacts).toHaveLength(PAGE_SIZE);
    expect(contacts.matchingCount).toBe(total);
    expect(contacts.totals.total).toBe(total);
    expect(contacts.nextCursor).not.toBeNull();

    // No shared/empty state: an empty org reports each tab's own zero, not
    // one combined flag.
    await reset();
    const emptyThreads = asThreadsTab(await loadPeople(fakeEvent(orgId, 'http://x/people')));
    expect(emptyThreads.conversations).toHaveLength(0);
    expect(emptyThreads.counts.all).toBe(0);
    const emptyContacts = asContactsTab(
      await loadPeople(fakeEvent(orgId, 'http://x/people?tab=contacts')),
    );
    expect(emptyContacts.contacts).toHaveLength(0);
    expect(emptyContacts.matchingCount).toBe(0);
  });

  it('each tab pages independently through its own JSON endpoint - no cross-tab bleed', async () => {
    const orgId = await getDefaultOrgId();
    const { all, total } = await seedRows();

    // Threads tab: page one from the merged loader, page two from the old
    // /conversations JSON endpoint - the exact fetch the tab's own "Load
    // more" button makes.
    const threadsPage1 = asThreadsTab(await loadPeople(fakeEvent(orgId, 'http://x/people')));
    const tCursor = threadsPage1.nextCursor!;
    const tPage2Url = `http://x/conversations?cursor_at=${encodeURIComponent(tCursor.sortAt)}&cursor_id=${tCursor.id}`;
    const tPage2Res = await loadMoreConversations(fakeEvent(orgId, tPage2Url));
    const tPage2 = (await tPage2Res.json()) as {
      conversations: Array<{ contactId: number }>;
      nextCursor: unknown;
    };
    expect(tPage2.conversations).toHaveLength(total - PAGE_SIZE);
    expect(tPage2.nextCursor).toBeNull();
    const threadsAppended = [...threadsPage1.conversations, ...tPage2.conversations].map(
      (c) => c.contactId,
    );
    expect(threadsAppended).toEqual(all.map((c) => c.id));

    // Contacts tab: independently paginated from page one - unaffected by
    // the threads cursor fetched above.
    const contactsPage1 = asContactsTab(
      await loadPeople(fakeEvent(orgId, 'http://x/people?tab=contacts')),
    );
    const cCursor = contactsPage1.nextCursor!;
    const cPage2Url = `http://x/contacts?cursor_at=${encodeURIComponent(cCursor.lastContactedAt)}&cursor_id=${cCursor.id}`;
    const cPage2Res = await loadMoreContacts(fakeEvent(orgId, cPage2Url));
    const cPage2 = (await cPage2Res.json()) as {
      contacts: Array<{ id: number }>;
      nextCursor: unknown;
    };
    expect(cPage2.contacts).toHaveLength(total - PAGE_SIZE);
    expect(cPage2.nextCursor).toBeNull();
    const contactsAppended = [...contactsPage1.contacts, ...cPage2.contacts].map((c) => c.id);
    expect(contactsAppended).toEqual(all.map((c) => c.id));

    // The two tabs' cursors are shaped differently and not interchangeable
    // - a contacts cursor never carries the threads field name and vice
    // versa, so one tab's "Load more" can never accidentally page the
    // other.
    expect(tCursor).toHaveProperty('sortAt');
    expect(tCursor).not.toHaveProperty('lastContactedAt');
    expect(cCursor).toHaveProperty('lastContactedAt');
    expect(cCursor).not.toHaveProperty('sortAt');
  });
});
