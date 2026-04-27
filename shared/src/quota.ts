import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';

export type QuotaKind = 'dm' | 'comment' | 'post';
export const QUOTA_KINDS: QuotaKind[] = ['dm', 'comment', 'post'];

export type WindowCounts = { day: number; week: number };
export type UsageByKind = Record<QuotaKind, WindowCounts>;

export type QuotaLimits = Record<QuotaKind, { perDay: number; perWeek: number }>;

export function emptyUsage(): UsageByKind {
  return {
    dm: { day: 0, week: 0 },
    comment: { day: 0, week: 0 },
    post: { day: 0, week: 0 },
  };
}

export function mapDraftKindToQuotaKind(
  draftKind: 'dm' | 'post_comment' | 'comment_reply' | 'post',
): QuotaKind {
  if (draftKind === 'dm') return 'dm';
  if (draftKind === 'post') return 'post';
  return 'comment';
}

export async function getUsageForAccounts(
  db: Db,
  accountIds: number[],
  now: Date = new Date(),
): Promise<Record<number, UsageByKind>> {
  const out: Record<number, UsageByKind> = {};
  for (const id of accountIds) out[id] = emptyUsage();
  if (accountIds.length === 0) return out;

  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      accountId: schema.drafts.accountId,
      kind: schema.drafts.kind,
      day: sql<number>`count(*) filter (where ${schema.drafts.sentAt} >= ${dayStart})::int`,
      week: sql<number>`count(*) filter (where ${schema.drafts.sentAt} >= ${weekStart})::int`,
    })
    .from(schema.drafts)
    .where(
      and(
        inArray(schema.drafts.accountId, accountIds),
        gte(schema.drafts.sentAt, weekStart),
      ),
    )
    .groupBy(schema.drafts.accountId, schema.drafts.kind);

  for (const r of rows) {
    const qk = mapDraftKindToQuotaKind(
      r.kind as 'dm' | 'post_comment' | 'comment_reply' | 'post',
    );
    const u = out[r.accountId];
    u[qk].day += Number(r.day);
    u[qk].week += Number(r.week);
  }
  return out;
}

export async function getAccountUsage(
  db: Db,
  accountId: number,
  now?: Date,
): Promise<UsageByKind> {
  const m = await getUsageForAccounts(db, [accountId], now);
  return m[accountId];
}

const QUOTA_LIMITS_FALLBACK: QuotaLimits = {
  dm: { perDay: 10, perWeek: 50 },
  comment: { perDay: 50, perWeek: 200 },
  post: { perDay: 5, perWeek: 20 },
};

export async function loadQuotaLimits(db: Db, platform: string): Promise<QuotaLimits> {
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'quota_defaults'))
    .limit(1);
  const blob = (row?.value ?? {}) as Record<string, unknown>;
  const platformBlob = (blob[platform] as QuotaLimits | undefined) ?? QUOTA_LIMITS_FALLBACK;
  return {
    dm: platformBlob.dm ?? QUOTA_LIMITS_FALLBACK.dm,
    comment: platformBlob.comment ?? QUOTA_LIMITS_FALLBACK.comment,
    post: platformBlob.post ?? QUOTA_LIMITS_FALLBACK.post,
  };
}

export function isOverQuota(
  usage: WindowCounts,
  limit: { perDay: number; perWeek: number },
): { overDay: boolean; overWeek: boolean } {
  return { overDay: usage.day >= limit.perDay, overWeek: usage.week >= limit.perWeek };
}
