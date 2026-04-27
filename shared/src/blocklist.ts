import { and, eq, or, sql } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type BlocklistCheck = {
  platformId: number;
  projectId: number;
  targetUser: string;
};

export type BlocklistResult = {
  blocked: boolean;
  reason: string | null;
};

export async function isBlocklisted(db: Db, args: BlocklistCheck): Promise<BlocklistResult> {
  const handle = args.targetUser.trim();
  if (!handle) return { blocked: false, reason: null };

  const [row] = await db
    .select({ reason: schema.blocklist.reason })
    .from(schema.blocklist)
    .where(
      and(
        eq(schema.blocklist.platformId, args.platformId),
        eq(schema.blocklist.kind, 'user'),
        sql`lower(${schema.blocklist.value}) = lower(${handle})`,
        or(
          eq(schema.blocklist.scope, 'global'),
          and(
            eq(schema.blocklist.scope, 'project'),
            eq(schema.blocklist.projectId, args.projectId),
          ),
        ),
      ),
    )
    .limit(1);

  return row ? { blocked: true, reason: row.reason ?? null } : { blocked: false, reason: null };
}
