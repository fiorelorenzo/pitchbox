import { and, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from './db.js';

/**
 * RFC 4180 CSV field escaping.
 * Quote fields containing comma, double-quote, CR or LF; escape `"` as `""`.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  const needsQuoting = /[",\r\n]/.test(s);
  if (!needsQuoting) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return values.map(escapeCsvField).join(',') + '\r\n';
}

export const DRAFTS_COLUMNS = [
  'id',
  'created_at',
  'state',
  'platform',
  'account_handle',
  'target_user',
  'target_subreddit',
  'campaign_id',
  'run_id',
  'body',
] as const;

export const CONTACTS_COLUMNS = [
  'id',
  'platform',
  'account_handle',
  'target_user',
  'first_contacted_at',
  'last_contacted_at',
  'outcome',
] as const;

export const CONVERSATIONS_COLUMNS = [
  'thread_id',
  'account_handle',
  'target_user',
  'kind',
  'last_message_at',
  'message_count',
] as const;

export type ResourceName = 'drafts' | 'contacts' | 'conversations';

export type DraftFilters = {
  state?: string | null;
  kind?: string | null;
  run?: string | null;
  campaign?: string | null;
  projectSlug?: string | null;
  platformSlug?: string | null;
};

export type ContactFilters = {
  platformSlug?: string | null;
  q?: string | null;
};

export type ConversationFilters = {
  filter?: 'all' | 'replied' | 'awaiting' | null;
  kind?: 'all' | 'dm' | 'post_comment' | null;
};

export function parseDraftFilters(params: URLSearchParams): DraftFilters {
  return {
    state: params.get('state') ?? 'pending_review',
    kind: params.get('kind'),
    run: params.get('run'),
    campaign: params.get('campaign'),
    projectSlug: params.get('project'),
    platformSlug: params.get('platform'),
  };
}

export function parseContactFilters(params: URLSearchParams): ContactFilters {
  return {
    platformSlug: params.get('platform'),
    q: params.get('q')?.trim() || null,
  };
}

export function parseConversationFilters(params: URLSearchParams): ConversationFilters {
  return {
    filter: (params.get('filter') as ConversationFilters['filter']) ?? 'all',
    kind: (params.get('kind') as ConversationFilters['kind']) ?? 'all',
  };
}

async function* draftRows(
  filters: DraftFilters,
  projectIds: number[],
): AsyncGenerator<readonly unknown[], void, unknown> {
  // No projects in this org - nothing to export. `inArray(x, [])` is a SQL error.
  if (projectIds.length === 0) return;
  const db = getDb();
  const sqlFilters: SQL[] = [inArray(schema.drafts.projectId, projectIds)];
  if (filters.state && filters.state !== 'all') {
    sqlFilters.push(eq(schema.drafts.state, filters.state));
  }
  if (filters.kind) sqlFilters.push(eq(schema.drafts.kind, filters.kind));

  if (filters.projectSlug) {
    const [proj] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.slug, filters.projectSlug));
    if (proj) sqlFilters.push(eq(schema.drafts.projectId, proj.id));
    else return;
  }
  if (filters.platformSlug) {
    const [plat] = await db
      .select({ id: schema.platforms.id })
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, filters.platformSlug));
    if (plat) sqlFilters.push(eq(schema.drafts.platformId, plat.id));
    else return;
  }
  if (filters.run) {
    sqlFilters.push(eq(schema.drafts.runId, Number(filters.run)));
  } else if (filters.campaign) {
    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.campaignId, Number(filters.campaign)));
    if (runs.length === 0) return;
    sqlFilters.push(
      inArray(
        schema.drafts.runId,
        runs.map((r) => r.id),
      ),
    );
  }

  const rows = await db
    .select({
      id: schema.drafts.id,
      createdAt: schema.drafts.createdAt,
      state: schema.drafts.state,
      platformSlug: schema.platforms.slug,
      accountHandle: schema.accounts.handle,
      targetUser: schema.drafts.targetUser,
      metadata: schema.drafts.metadata,
      campaignId: schema.runs.campaignId,
      runId: schema.drafts.runId,
      body: schema.drafts.body,
    })
    .from(schema.drafts)
    .innerJoin(schema.platforms, eq(schema.platforms.id, schema.drafts.platformId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.drafts.accountId))
    .leftJoin(schema.runs, eq(schema.runs.id, schema.drafts.runId))
    .where(sqlFilters.length > 0 ? and(...sqlFilters) : undefined)
    .orderBy(schema.drafts.id);

  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const subreddit = typeof meta.subreddit === 'string' ? meta.subreddit : '';
    yield [
      r.id,
      r.createdAt,
      r.state,
      r.platformSlug ?? '',
      r.accountHandle ?? '',
      r.targetUser ?? '',
      subreddit,
      r.campaignId ?? '',
      r.runId,
      r.body,
    ];
  }
}

async function* contactRows(
  filters: ContactFilters,
  orgId: number | null,
): AsyncGenerator<readonly unknown[], void, unknown> {
  // No resolved org - nothing to export (fail closed, not open).
  if (orgId == null) return;
  const db = getDb();
  // contact_history.organization_id is set from the draft's project at
  // insert time and survives retention pruning the draft (draft_id -> null,
  // see docs/organization-isolation-design.md and shared/src/db/schema.ts),
  // so it - not a join through drafts.projectId - is the only column that
  // can scope this without silently dropping pruned contacts.
  const sqlFilters: SQL[] = [eq(schema.contactHistory.organizationId, orgId)];
  if (filters.platformSlug) {
    const [plat] = await db
      .select({ id: schema.platforms.id })
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, filters.platformSlug));
    if (plat) sqlFilters.push(eq(schema.contactHistory.platformId, plat.id));
    else return;
  }
  if (filters.q) {
    sqlFilters.push(ilike(schema.contactHistory.targetUser, `%${filters.q}%`));
  }

  // Aggregate first/last contact per (platform_id, account_handle, target_user).
  // contact_history rows already represent one row per contact event for a draft;
  // we need first_contacted_at across the whole tuple.
  const rows = await db
    .select({
      id: schema.contactHistory.id,
      platformSlug: schema.platforms.slug,
      platformId: schema.contactHistory.platformId,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
      replyCheckedAt: schema.contactHistory.replyCheckedAt,
    })
    .from(schema.contactHistory)
    .innerJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .where(and(...sqlFilters))
    .orderBy(schema.contactHistory.id);

  // Pre-compute first_contacted_at per tuple using a SQL min() pass, scoped
  // to the same org directly so a cross-org row sharing a
  // (platform, account_handle, target_user) tuple never leaks into this
  // export's first-contacted date.
  const firstByKey = new Map<string, Date>();
  const firstRows = await db
    .select({
      platformId: schema.contactHistory.platformId,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      firstAt: sql<Date>`min(${schema.contactHistory.lastContactedAt})`,
    })
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.organizationId, orgId))
    .groupBy(
      schema.contactHistory.platformId,
      schema.contactHistory.accountHandle,
      schema.contactHistory.targetUser,
    );
  for (const r of firstRows) {
    // `min()` returns a raw timestamp string from pg - coerce to Date so the
    // CSV emitter formats it as ISO consistently with column-typed columns.
    const first = r.firstAt instanceof Date ? r.firstAt : new Date(r.firstAt as unknown as string);
    firstByKey.set(`${r.platformId}|${r.accountHandle}|${r.targetUser}`, first);
  }

  for (const r of rows) {
    const outcome = r.repliedAt ? 'replied' : r.replyCheckedAt ? 'no_reply' : 'unchecked';
    const first = firstByKey.get(`${r.platformId}|${r.accountHandle}|${r.targetUser}`);
    yield [
      r.id,
      r.platformSlug ?? '',
      r.accountHandle,
      r.targetUser,
      first ?? r.lastContactedAt,
      r.lastContactedAt,
      outcome,
    ];
  }
}

async function* conversationRows(
  filters: ConversationFilters,
  projectIds: number[],
  orgId: number | null,
): AsyncGenerator<readonly unknown[], void, unknown> {
  // No resolved org - nothing to export (fail closed, not open).
  if (orgId == null) return;
  const db = getDb();
  const hasProjects = projectIds.length > 0;

  // contact_history.organization_id is set from the draft's project at
  // insert time and survives retention pruning the draft (draft_id -> null,
  // see docs/organization-isolation-design.md and shared/src/db/schema.ts),
  // so it directly scopes contact_history here. The draft join below is now
  // a plain join for display fields only: any draft still reachable from an
  // org-scoped contact is guaranteed to be in the same org (that's exactly
  // what organization_id is derived from), so it needs no extra filter of
  // its own.
  //
  // Per-contact message aggregate joined onto contact_history.
  // thread_id := chat_room_id when present, otherwise `contact:<id>`.
  const rows = await db
    .select({
      contactId: schema.contactHistory.id,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      chatRoomId: schema.contactHistory.chatRoomId,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      repliedAt: schema.contactHistory.repliedAt,
      draftKind: schema.drafts.kind,
    })
    .from(schema.contactHistory)
    .leftJoin(schema.drafts, eq(schema.contactHistory.draftId, schema.drafts.id))
    .where(eq(schema.contactHistory.organizationId, orgId))
    .orderBy(schema.contactHistory.id);

  const contactIds = rows.map((r) => r.contactId);
  const counts = new Map<number, { count: number; last: Date | null }>();
  // Messages have no organization_id column of their own - unlike
  // contact_history, they're attributed to an org only through the draft
  // they were matched to (drafts.projectId). A message with no draftId (or
  // a pruned one) cannot be attributed to any org, so it is excluded here
  // rather than risk counting it across tenants.
  if (contactIds.length > 0 && hasProjects) {
    const aggs = await db
      .select({
        contactId: schema.messages.contactId,
        count: sql<number>`count(*)::int`,
        last: sql<Date>`max(${schema.messages.createdAtPlatform})`,
      })
      .from(schema.messages)
      .innerJoin(schema.drafts, eq(schema.messages.draftId, schema.drafts.id))
      .where(
        and(
          inArray(schema.messages.contactId, contactIds),
          inArray(schema.drafts.projectId, projectIds),
        ),
      )
      .groupBy(schema.messages.contactId);
    for (const a of aggs) {
      // `max()` returns a raw timestamp string from pg - coerce to Date.
      const last = a.last instanceof Date ? a.last : new Date(a.last as unknown as string);
      counts.set(a.contactId, { count: a.count, last });
    }
  }

  for (const r of rows) {
    // Apply post-filter on `filter` and `kind` to mirror the page's client-side filter.
    if (filters.filter === 'replied' && !r.repliedAt) continue;
    if (filters.filter === 'awaiting' && r.repliedAt) continue;
    if (filters.kind && filters.kind !== 'all' && r.draftKind !== filters.kind) continue;

    const agg = counts.get(r.contactId) ?? { count: 0, last: null };
    const threadId = r.chatRoomId ?? `contact:${r.contactId}`;
    yield [
      threadId,
      r.accountHandle,
      r.targetUser,
      r.draftKind ?? '',
      agg.last ?? r.repliedAt ?? r.lastContactedAt,
      agg.count,
    ];
  }
}

/**
 * `projectIds` scopes `drafts` (a real per-project filter: it carries a
 * `project_id` column directly) and the `conversations` message aggregate,
 * which has to reach org through the matched draft since `messages` has no
 * organization column of its own.
 *
 * `orgId` scopes `contact_history` directly (`contacts`, and the top-level
 * row set for `conversations`). `contact_history.organization_id` is set
 * once from the draft's project at insert time and survives retention
 * pruning the draft (draft_id -> null, see
 * docs/organization-isolation-design.md), so a `projectIds`/`drafts` join
 * would silently drop exactly the pruned, oldest rows - the direct column is
 * the only correct way to scope it.
 */
export function streamCsv(
  resource: ResourceName,
  params: URLSearchParams,
  projectIds: number[],
  orgId: number | null,
): Response {
  let header: readonly string[];
  let gen: AsyncGenerator<readonly unknown[], void, unknown>;
  switch (resource) {
    case 'drafts':
      header = DRAFTS_COLUMNS;
      gen = draftRows(parseDraftFilters(params), projectIds);
      break;
    case 'contacts':
      header = CONTACTS_COLUMNS;
      gen = contactRows(parseContactFilters(params), orgId);
      break;
    case 'conversations':
      header = CONVERSATIONS_COLUMNS;
      gen = conversationRows(parseConversationFilters(params), projectIds, orgId);
      break;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvRow(header as unknown as unknown[])));
        for await (const row of gen) {
          controller.enqueue(encoder.encode(csvRow(row as unknown[])));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const filename = `${resource}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
