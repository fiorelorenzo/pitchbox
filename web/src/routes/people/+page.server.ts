import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { eq, sql } from 'drizzle-orm';
import { requireOrgId } from '$lib/server/auth.js';
import {
  getExtensionDeviceNudge,
  hasChatUnauthorizedDevice,
  type ExtensionDeviceNudge,
} from '$lib/server/extension-sync.js';
import {
  resolveContactsScope,
  queryContactsPage,
  type ContactsPage,
} from '$lib/server/contacts-query.js';
import {
  resolveConversationsScope,
  queryConversationsPage,
  type ConversationRow,
  type ConversationsPage,
} from '$lib/server/conversations-query.js';

export type PeopleTab = 'threads' | 'contacts';

// The loader's data shape is genuinely different per tab (contacts rows vs.
// conversation rows, distinct cursor shapes - see contacts-query.ts /
// conversations-query.ts), so it is named as a real discriminated union
// here rather than left for callers to infer from the return statements.
export type ContactsTabData = {
  tab: 'contacts';
  contacts: ContactsPage['contacts'];
  platforms: { id: number; slug: string }[];
  filters: { platform: string | null; q: string };
  totals: { unique: number; total: number; replied: number };
  nextCursor: ContactsPage['nextCursor'];
  matchingCount: number;
};

export type ThreadsTabData = {
  tab: 'threads';
  conversations: ConversationRow[];
  filters: { filter: string; kind: string; q: string };
  counts: { all: number; replied: number; awaiting: number };
  nextCursor: ConversationsPage['nextCursor'];
  chatSyncUnauthorized: boolean;
  extensionNudge: ExtensionDeviceNudge;
  orgId: number;
};

export type PeoplePageData = ContactsTabData | ThreadsTabData;

/**
 * `/contacts` and `/conversations` merged into this one `People` page with
 * two tabs. Each tab still runs the exact same scope-resolution + paginated
 * query as its old standalone page (`contacts-query.ts` /
 * `conversations-query.ts`, unchanged) - only the loader that calls them
 * moved. Only the active tab's data is fetched; switching tabs is a real
 * navigation (the tab lives in `?tab=`, see +page.svelte's `setTab`), so it
 * always lands on page one of whatever the new tab's filters select. The
 * old routes' `+server.ts` JSON endpoints still back each tab's "Load more"
 * fetch directly - reused as-is, not duplicated here.
 */
export async function load(event: RequestEvent): Promise<PeoplePageData> {
  const { url } = event;
  // `tab=contacts` selects "All contacts"; anything else (including the
  // param's absence) is "Threads" - the default because it's the tab with
  // pending work in it (#252).
  const tab: PeopleTab = url.searchParams.get('tab') === 'contacts' ? 'contacts' : 'threads';
  const db = getDb();

  if (tab === 'contacts') {
    const orgId = await requireOrgId(event);
    const scope = await resolveContactsScope(db, orgId, url);
    const { contacts, matchingCount, nextCursor } = await queryContactsPage(db, scope);

    const [totalRow] = await db
      .select({
        unique: sql<number>`COUNT(DISTINCT (platform_id, target_user))::int`,
        total: sql<number>`COUNT(*)::int`,
        replied: sql<number>`COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
      })
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.organizationId, orgId));

    return {
      tab,
      contacts,
      platforms: scope.platforms,
      filters: {
        platform: url.searchParams.get('platform') ?? null,
        q: scope.query,
      },
      totals: {
        unique: totalRow?.unique ?? 0,
        total: totalRow?.total ?? 0,
        replied: totalRow?.replied ?? 0,
      },
      nextCursor,
      matchingCount,
    };
  }

  const chatSyncUnauthorized = await hasChatUnauthorizedDevice();
  const orgId = await requireOrgId(event);
  const extensionNudge = await getExtensionDeviceNudge(orgId);

  const scope = await resolveConversationsScope(db, orgId, url);
  const { conversations, nextCursor } = await queryConversationsPage(db, scope);

  // Cheap, unfiltered tab counts (mirrors the old /conversations loader).
  const [countsRow] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      replied: sql<number>`COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
      awaiting: sql<number>`COUNT(*) FILTER (WHERE replied_at IS NULL)::int`,
    })
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.organizationId, orgId));

  return {
    tab,
    conversations,
    filters: {
      filter: scope.filterParam ?? 'all',
      kind: scope.kindParam ?? 'all',
      q: scope.search,
    },
    counts: {
      all: countsRow?.total ?? 0,
      replied: countsRow?.replied ?? 0,
      awaiting: countsRow?.awaiting ?? 0,
    },
    nextCursor,
    chatSyncUnauthorized,
    extensionNudge,
    orgId,
  };
}
