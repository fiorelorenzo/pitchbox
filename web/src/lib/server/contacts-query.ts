import { and, desc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db.js';

export const CONTACTS_PAGE_SIZE = 50;

export type ContactsCursor = { lastContactedAt: Date; id: string } | null;

export function parseContactsCursor(url: URL): ContactsCursor {
  const cursorAtRaw = url.searchParams.get('cursor_at');
  const cursorIdRaw = url.searchParams.get('cursor_id');
  return cursorAtRaw && cursorIdRaw && !Number.isNaN(new Date(cursorAtRaw).getTime())
    ? { lastContactedAt: new Date(cursorAtRaw), id: cursorIdRaw }
    : null;
}

export type ContactsScope = {
  platforms: { id: number; slug: string }[];
  orgId: number;
  platformId: number | null;
  query: string;
  cursor: ContactsCursor;
};

/**
 * Resolves the org/platform/search scope shared by the page loader (first
 * page, plus the platform dropdown options) and the "Load more" JSON
 * endpoint (subsequent pages) - see /audit for the pattern this mirrors.
 */
export async function resolveContactsScope(
  db: Db,
  orgId: number,
  url: URL,
): Promise<ContactsScope> {
  const platforms = await db.select().from(schema.platforms).orderBy(schema.platforms.slug);
  const platformSlug = url.searchParams.get('platform');
  const platformMatch = platformSlug
    ? (platforms.find((p) => p.slug === platformSlug) ?? null)
    : null;

  return {
    platforms,
    orgId,
    platformId: platformMatch?.id ?? null,
    query: url.searchParams.get('q')?.trim() ?? '',
    cursor: parseContactsCursor(url),
  };
}

export type ContactsPage = {
  contacts: Array<{
    id: number;
    platformId: number;
    platformSlug: string | null;
    accountHandle: string;
    targetUser: string;
    lastContactedAt: Date;
    repliedAt: Date | null;
    replyCheckedAt: Date | null;
    draftId: number | null;
    draftKind: string | null;
    draftRunId: number | null;
    draftState: string | null;
  }>;
  matchingCount: number;
  nextCursor: { lastContactedAt: string; id: string } | null;
};

/**
 * Runs the actual paginated contacts query for a resolved `ContactsScope`.
 * Used by both the page loader (first page) and the "Load more" JSON
 * endpoint (subsequent pages) so the SQL never drifts between them.
 */
export async function queryContactsPage(
  db: Db,
  scope: ContactsScope,
  pageSize = CONTACTS_PAGE_SIZE,
): Promise<ContactsPage> {
  const filters: SQL[] = [eq(schema.contactHistory.organizationId, scope.orgId)];
  if (scope.platformId != null)
    filters.push(eq(schema.contactHistory.platformId, scope.platformId));
  if (scope.query) filters.push(ilike(schema.contactHistory.targetUser, `%${scope.query}%`));

  // contact_history is org-scoped (#263): a row's organization_id always
  // equals its draft's project org by construction, so the drafts join
  // needs no extra guard.
  const draftJoinCond = eq(schema.contactHistory.draftId, schema.drafts.id);

  const [matchingRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.contactHistory)
    .where(and(...filters));
  const matchingCount = matchingRow?.count ?? 0;

  const pageFilters = scope.cursor
    ? [
        ...filters,
        sql`(${schema.contactHistory.lastContactedAt}, ${schema.contactHistory.id}) < (${scope.cursor.lastContactedAt.toISOString()}::timestamptz, ${scope.cursor.id}::bigint)`,
      ]
    : filters;

  const contacts = await db
    .select({
      id: schema.contactHistory.id,
      platformId: schema.contactHistory.platformId,
      platformSlug: schema.platforms.slug,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
      replyCheckedAt: schema.contactHistory.replyCheckedAt,
      draftId: schema.contactHistory.draftId,
      draftKind: schema.drafts.kind,
      draftRunId: schema.drafts.runId,
      draftState: schema.drafts.state,
    })
    .from(schema.contactHistory)
    .leftJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .leftJoin(schema.drafts, draftJoinCond)
    .where(and(...pageFilters))
    .orderBy(desc(schema.contactHistory.lastContactedAt), desc(schema.contactHistory.id))
    .limit(pageSize);

  const nextCursor =
    contacts.length === pageSize
      ? {
          lastContactedAt: contacts[contacts.length - 1].lastContactedAt.toISOString(),
          id: String(contacts[contacts.length - 1].id),
        }
      : null;

  return { contacts, matchingCount, nextCursor };
}
