import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db.js';
import { listProjects } from '@pitchbox/shared/projects';

export const CONVERSATIONS_PAGE_SIZE = 50;

export type ConversationsCursor = { sortAt: Date; id: string } | null;

export function parseConversationsCursor(url: URL): ConversationsCursor {
  const cursorAtRaw = url.searchParams.get('cursor_at');
  const cursorIdRaw = url.searchParams.get('cursor_id');
  return cursorAtRaw && cursorIdRaw && !Number.isNaN(new Date(cursorAtRaw).getTime())
    ? { sortAt: new Date(cursorAtRaw), id: cursorIdRaw }
    : null;
}

export type ConversationsScope = {
  projectIds: number[];
  hasProjects: boolean;
  filterParam: string | null;
  kindParam: string | null;
  search: string;
  cursor: ConversationsCursor;
};

/**
 * Resolves the org/filter/search scope shared by the page loader (first
 * page) and the "Load more" JSON endpoint (subsequent pages) - see /audit
 * for the pattern this mirrors.
 */
export async function resolveConversationsScope(
  db: Db,
  orgId: number | null,
  url: URL,
): Promise<ConversationsScope> {
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);
  return {
    projectIds,
    hasProjects: projectIds.length > 0,
    filterParam: url.searchParams.get('filter'),
    kindParam: url.searchParams.get('kind'),
    search: url.searchParams.get('q')?.trim() || '',
    cursor: parseConversationsCursor(url),
  };
}

export type ConversationRow = {
  contactId: number;
  accountHandle: string;
  targetUser: string;
  platformSlug: string;
  lastContactedAt: Date;
  repliedAt: Date | null;
  chatRoomId: string | null;
  draftId: number | null;
  draftKind: string | null;
  draftState: string | null;
  draftBody: string | null;
  draftMetadata: Record<string, unknown> | null;
  platformContextUrl: string | null;
  lastMessage: {
    body: string;
    author: string;
    createdAt: Date;
    isFromUs: boolean;
  } | null;
};

export type ConversationsPage = {
  conversations: ConversationRow[];
  nextCursor: { sortAt: string; id: string } | null;
};

/**
 * Runs the actual paginated conversations query for a resolved
 * `ConversationsScope`. Used by both the page loader (first page) and the
 * "Load more" JSON endpoint (subsequent pages) so the SQL - including the
 * message-body search - never drifts between them.
 */
export async function queryConversationsPage(
  db: Db,
  scope: ConversationsScope,
  pageSize = CONVERSATIONS_PAGE_SIZE,
): Promise<ConversationsPage> {
  // contact_history is a global accepted residual (see the
  // organization-isolation design doc), so every contact row stays visible.
  // The attached draft is not: scope the drafts join to the active org's
  // projects so a cross-org draft's kind/state/body/metadata never renders -
  // when there is no match (or the org has no projects) the join yields nulls.
  const draftJoinCond = and(
    eq(schema.contactHistory.draftId, schema.drafts.id),
    scope.hasProjects ? inArray(schema.drafts.projectId, scope.projectIds) : sql`false`,
  );

  // Latest inbound/outbound message per contact, scoped the same way
  // draftJoinCond scopes drafts: a message with no org-attributable draft is
  // excluded rather than risked across tenants. row_number() (rather than
  // DISTINCT ON) so it composes as a plain subquery the outer query can
  // filter and join against.
  const rankedMessages = db
    .select({
      contactId: schema.messages.contactId,
      body: schema.messages.body,
      author: schema.messages.author,
      createdAt: schema.messages.createdAtPlatform,
      isFromUs: schema.messages.isFromUs,
      rn: sql<number>`row_number() over (partition by ${schema.messages.contactId} order by ${schema.messages.createdAtPlatform} desc)`.as(
        'rn',
      ),
    })
    .from(schema.messages)
    .innerJoin(schema.drafts, eq(schema.messages.draftId, schema.drafts.id))
    .where(scope.hasProjects ? inArray(schema.drafts.projectId, scope.projectIds) : sql`false`)
    .as('ranked_messages');

  const latestMessage = db
    .select({
      contactId: rankedMessages.contactId,
      body: rankedMessages.body,
      author: rankedMessages.author,
      createdAt: rankedMessages.createdAt,
      isFromUs: rankedMessages.isFromUs,
    })
    .from(rankedMessages)
    .where(eq(rankedMessages.rn, 1))
    .as('latest_message');

  const filters: SQL[] = [];
  if (scope.filterParam === 'replied') filters.push(isNotNull(schema.contactHistory.repliedAt));
  else if (scope.filterParam === 'awaiting') filters.push(isNull(schema.contactHistory.repliedAt));
  if (scope.kindParam && scope.kindParam !== 'all')
    filters.push(eq(schema.drafts.kind, scope.kindParam));
  if (scope.search) {
    const q = `%${scope.search}%`;
    filters.push(
      or(
        ilike(schema.contactHistory.targetUser, q),
        ilike(schema.contactHistory.accountHandle, q),
        ilike(latestMessage.body, q),
      )!,
    );
  }

  const sortExpr = sql`coalesce(${schema.contactHistory.repliedAt}, ${schema.contactHistory.lastContactedAt})`;
  const pageFilters = scope.cursor
    ? [
        ...filters,
        sql`(${sortExpr}, ${schema.contactHistory.id}) < (${scope.cursor.sortAt.toISOString()}::timestamptz, ${scope.cursor.id}::bigint)`,
      ]
    : filters;

  const rows = await db
    .select({
      contactId: schema.contactHistory.id,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      platformSlug: schema.platforms.slug,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
      chatRoomId: schema.contactHistory.chatRoomId,
      draftId: schema.contactHistory.draftId,
      draftKind: schema.drafts.kind,
      draftState: schema.drafts.state,
      draftBody: schema.drafts.body,
      draftMetadata: schema.drafts.metadata,
      platformContextUrl: schema.contactHistory.platformContextUrl,
      lastMessageBody: latestMessage.body,
      lastMessageAuthor: latestMessage.author,
      lastMessageCreatedAt: latestMessage.createdAt,
      lastMessageIsFromUs: latestMessage.isFromUs,
    })
    .from(schema.contactHistory)
    .innerJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .leftJoin(schema.drafts, draftJoinCond)
    .leftJoin(latestMessage, eq(latestMessage.contactId, schema.contactHistory.id))
    .where(pageFilters.length > 0 ? and(...pageFilters) : undefined)
    .orderBy(sql`${sortExpr} desc`, desc(schema.contactHistory.id))
    .limit(pageSize);

  const nextCursor =
    rows.length === pageSize
      ? {
          sortAt: (
            rows[rows.length - 1].repliedAt ?? rows[rows.length - 1].lastContactedAt
          ).toISOString(),
          id: String(rows[rows.length - 1].contactId),
        }
      : null;

  return {
    conversations: rows.map((r) => ({
      contactId: r.contactId,
      accountHandle: r.accountHandle,
      targetUser: r.targetUser,
      platformSlug: r.platformSlug,
      lastContactedAt: r.lastContactedAt,
      repliedAt: r.repliedAt,
      chatRoomId: r.chatRoomId,
      draftId: r.draftId,
      draftKind: r.draftKind,
      draftState: r.draftState,
      draftBody: r.draftBody,
      // drafts.metadata is a jsonb column with no drizzle $type<>() (only 1
      // of 13 jsonb columns in the shared schema uses that today), so
      // drizzle infers `unknown` here; left-joined rows with no matching
      // draft genuinely yield null, which this cast preserves.
      draftMetadata: r.draftMetadata as Record<string, unknown> | null,
      platformContextUrl: r.platformContextUrl,
      lastMessage:
        r.lastMessageBody != null
          ? {
              body: r.lastMessageBody,
              author: r.lastMessageAuthor as string,
              createdAt: r.lastMessageCreatedAt as Date,
              isFromUs: r.lastMessageIsFromUs as boolean,
            }
          : null,
    })),
    nextCursor,
  };
}
