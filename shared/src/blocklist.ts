import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type BlocklistResult = {
  blocked: boolean;
  reason: string | null;
};

// Global entries always apply; project-scoped entries only apply within their
// own project. `projectId: null` means "no project context" - only global
// entries can match in that case.
function scopeClause(projectId: number | null): SQL {
  if (projectId == null) return eq(schema.blocklist.scope, 'global');
  return or(
    eq(schema.blocklist.scope, 'global'),
    and(eq(schema.blocklist.scope, 'project'), eq(schema.blocklist.projectId, projectId)),
  )!;
}

async function matchExact(
  db: Db,
  args: { platformId: number; projectId: number | null; kind: string; value: string },
): Promise<BlocklistResult> {
  const [row] = await db
    .select({ reason: schema.blocklist.reason })
    .from(schema.blocklist)
    .where(
      and(
        eq(schema.blocklist.platformId, args.platformId),
        eq(schema.blocklist.kind, args.kind),
        sql`lower(${schema.blocklist.value}) = lower(${args.value})`,
        scopeClause(args.projectId),
      ),
    )
    .limit(1);
  return row ? { blocked: true, reason: row.reason ?? null } : { blocked: false, reason: null };
}

async function matchSubstring(
  db: Db,
  args: { platformId: number; projectId: number | null; kind: string; haystack: string },
): Promise<BlocklistResult> {
  const [row] = await db
    .select({ reason: schema.blocklist.reason })
    .from(schema.blocklist)
    .where(
      and(
        eq(schema.blocklist.platformId, args.platformId),
        eq(schema.blocklist.kind, args.kind),
        sql`lower(${args.haystack}) like '%' || lower(${schema.blocklist.value}) || '%'`,
        scopeClause(args.projectId),
      ),
    )
    .limit(1);
  return row ? { blocked: true, reason: row.reason ?? null } : { blocked: false, reason: null };
}

export type BlocklistCheck = {
  platformId: number;
  projectId: number | null;
  targetUser: string;
};

/** Checks the `user`-kind blocklist for a target handle (case-insensitive, global-or-project scope). */
export async function isBlocklisted(db: Db, args: BlocklistCheck): Promise<BlocklistResult> {
  const handle = args.targetUser.trim();
  if (!handle) return { blocked: false, reason: null };
  return matchExact(db, {
    platformId: args.platformId,
    projectId: args.projectId,
    kind: 'user',
    value: handle,
  });
}

export type SubredditBlocklistCheck = {
  platformId: number;
  projectId: number | null;
  subreddit: string;
};

/** Checks the `subreddit`-kind blocklist for a target subreddit name (case-insensitive, global-or-project scope). */
export async function isSubredditBlocklisted(
  db: Db,
  args: SubredditBlocklistCheck,
): Promise<BlocklistResult> {
  const name = args.subreddit.trim();
  if (!name) return { blocked: false, reason: null };
  return matchExact(db, {
    platformId: args.platformId,
    projectId: args.projectId,
    kind: 'subreddit',
    value: name,
  });
}

export type KeywordBlocklistCheck = {
  platformId: number;
  projectId: number | null;
  text: string;
};

/** Checks the `keyword`-kind blocklist against a body of text (case-insensitive substring, global-or-project scope). */
export async function isKeywordBlocklisted(
  db: Db,
  args: KeywordBlocklistCheck,
): Promise<BlocklistResult> {
  const text = args.text.trim();
  if (!text) return { blocked: false, reason: null };
  return matchSubstring(db, {
    platformId: args.platformId,
    projectId: args.projectId,
    kind: 'keyword',
    haystack: text,
  });
}
