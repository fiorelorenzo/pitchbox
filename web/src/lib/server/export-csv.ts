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
): AsyncGenerator<readonly unknown[], void, unknown> {
  const db = getDb();
  const sqlFilters: SQL[] = [];
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
    .where(sqlFilters.length > 0 ? and(...sqlFilters) : undefined)
    .orderBy(schema.contactHistory.id);

  // Pre-compute first_contacted_at per tuple using a SQL min() pass.
  const firstByKey = new Map<string, Date>();
  const firstRows = await db
    .select({
      platformId: schema.contactHistory.platformId,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      firstAt: sql<Date>`min(${schema.contactHistory.lastContactedAt})`,
    })
    .from(schema.contactHistory)
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
): AsyncGenerator<readonly unknown[], void, unknown> {
  const db = getDb();
  const hasProjects = projectIds.length > 0;

  // contact_history is a global accepted residual (see "Residual risks" in
  // docs/organization-isolation-design.md), so every contact row stays in the
  // export. The attached draft is not: scope the join to the active org's
  // projects so a cross-org draft's kind never leaks into the export.
  const draftJoinCond = and(
    eq(schema.contactHistory.draftId, schema.drafts.id),
    hasProjects ? inArray(schema.drafts.projectId, projectIds) : sql`false`,
  );

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
    .leftJoin(schema.drafts, draftJoinCond)
    .orderBy(schema.contactHistory.id);

  const contactIds = rows.map((r) => r.contactId);
  const counts = new Map<number, { count: number; last: Date | null }>();
  // Messages are attributed to an org through the draft they were matched to
  // (drafts.projectId); a message with no draftId cannot be attributed to any
  // org, so it is excluded here rather than risk counting it across tenants.
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
 * `projectIds` scopes the export to the active organization's projects.
 * `drafts` carries a `project_id` column directly and is filtered on it
 * directly; `conversations` has no project column on `contact_history` itself
 * but reaches the org through the attached draft (`drafts.projectId`), so its
 * message aggregate and draft fields are scoped the same way. `contacts` is
 * backed only by `contact_history`, which has no project column at all and
 * stays global by design (see "Residual risks" in
 * `docs/organization-isolation-design.md`).
 */
export function streamCsv(
  resource: ResourceName,
  params: URLSearchParams,
  projectIds: number[],
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
      gen = contactRows(parseContactFilters(params));
      break;
    case 'conversations':
      header = CONVERSATIONS_COLUMNS;
      gen = conversationRows(parseConversationFilters(params), projectIds);
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
