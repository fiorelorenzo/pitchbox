import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import {
  isDraftKind,
  mapDraftKindToQuotaKind,
  emptyUsage,
  QUOTA_LIMITS_FALLBACK,
} from './quota-types.js';
import type { QuotaLimits, UsageByKind } from './quota-types.js';

export * from './quota-types.js';

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
    .where(and(inArray(schema.drafts.accountId, accountIds), gte(schema.drafts.sentAt, weekStart)))
    .groupBy(schema.drafts.accountId, schema.drafts.kind);

  for (const r of rows) {
    if (!isDraftKind(r.kind)) continue; // future-proof: skip unknown draft kinds
    const qk = mapDraftKindToQuotaKind(r.kind);
    const u = out[r.accountId];
    u[qk].day += Number(r.day);
    u[qk].week += Number(r.week);
  }
  return out;
}

export async function getAccountUsage(db: Db, accountId: number, now?: Date): Promise<UsageByKind> {
  const m = await getUsageForAccounts(db, [accountId], now);
  return m[accountId];
}

export type QuotaWindow = 'day' | 'week';
export type QuotaCheck = {
  limit: number;
  used: number;
  remaining: number;
  kind: 'platform' | 'account';
};

/**
 * Compute the binding quota for a given account+kind+window.
 *
 * The binding limit is the minimum of the platform-wide limit (from
 * `app_config.quota_defaults`) and the optional per-account override
 * (`accounts.daily_limit` / `accounts.weekly_limit`). When both are set, the
 * smaller one wins and `kind` reflects which side bound. On ties, the
 * account-level override is preferred so users see their explicit setting.
 */
export function checkQuota(args: {
  platformLimit: number;
  accountLimit: number | null | undefined;
  used: number;
}): QuotaCheck {
  const { platformLimit, accountLimit, used } = args;
  let limit = platformLimit;
  let kind: 'platform' | 'account' = 'platform';
  if (accountLimit != null && accountLimit <= platformLimit) {
    limit = accountLimit;
    kind = 'account';
  }
  const remaining = Math.max(0, limit - used);
  return { limit, used, remaining, kind };
}

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
