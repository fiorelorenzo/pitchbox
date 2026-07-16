import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { isBlocklisted } from './blocklist.js';
import {
  checkQuota,
  getAccountUsage,
  isDraftKind,
  loadQuotaLimits,
  mapDraftKindToQuotaKind,
  type QuotaKind,
} from './quota.js';

export type DraftLike = {
  platformId: number;
  projectId: number;
  accountId: number;
  targetUser: string | null;
  kind: string;
  scheduledSendAfter?: Date | null;
  draftingRunId?: number | null;
};

export type SendEvaluation =
  | { kind: 'drafting' }
  | { kind: 'blocked'; reason: string | null }
  | { kind: 'scheduled'; sendAfter: Date }
  | {
      kind: 'quota_exceeded';
      window: 'day' | 'week';
      quotaKind: QuotaKind;
      limit: number;
      used: number;
    }
  | { kind: 'ok'; quotaEventDetails: Record<string, unknown> | null };

/**
 * Decide whether a draft can transition to `sent`, and (if yes) compute the
 * `draft_events.details` payload describing any quota breach. The function
 * does not write anything - callers own DB mutations.
 *
 * NOTE on the +1: `getAccountUsage` reads `drafts.sent_at` from the DB.
 * Callers invoke this helper BEFORE writing the new `sent_at`, so the count
 * we compute is "drafts already sent BEFORE this one". To detect whether THIS
 * send pushes the account over the cap we add 1. We use strict `>` so that
 * exactly-at-limit counts (e.g. day=10, perDay=10 after +1=11) correctly
 * trigger an over-quota event.
 *
 * NOTE on enforcement: the binding limit per window is `min(platform default,
 * per-account override)` via `checkQuota`. Breaching the platform-wide
 * default alone stays a soft, log-only signal (`kind: 'ok'` with
 * `quotaEventDetails` set) to preserve today's dashboard behavior. But once an
 * explicit per-account override (`accounts.daily_limit` / `weekly_limit`) is
 * the tighter, binding limit, breaching it actually blocks the send
 * (`kind: 'quota_exceeded'`) - that override is a deliberate cap the operator
 * set, not a shared default.
 */
export async function evaluateDraftSend(
  db: Db,
  draft: DraftLike,
  now: Date = new Date(),
): Promise<SendEvaluation> {
  // Placeholder reply drafts (drafting_run_id set) are still being written by
  // the agent - never approvable or sendable until the run finishes and
  // clears the flag.
  if (draft.draftingRunId != null) {
    return { kind: 'drafting' as const };
  }

  // Scheduled send-after: drafts with a future scheduled_send_after are not
  // considered ready to send.
  if (draft.scheduledSendAfter && draft.scheduledSendAfter.getTime() > now.getTime()) {
    return { kind: 'scheduled', sendAfter: draft.scheduledSendAfter };
  }

  // Blocklist check (skip when no targetUser)
  if (draft.targetUser) {
    const r = await isBlocklisted(db, {
      platformId: draft.platformId,
      projectId: draft.projectId,
      targetUser: draft.targetUser,
    });
    if (r.blocked) return { kind: 'blocked', reason: r.reason };
  }

  // Quota check
  const [platform] = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.id, draft.platformId));
  const [account] = await db
    .select({ dailyLimit: schema.accounts.dailyLimit, weeklyLimit: schema.accounts.weeklyLimit })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, draft.accountId));
  const usage = await getAccountUsage(db, draft.accountId, now);
  const limits = await loadQuotaLimits(db, platform?.slug ?? 'reddit');

  if (!isDraftKind(draft.kind)) {
    // Unknown kind - no quota applies; treat as unrestricted
    return { kind: 'ok', quotaEventDetails: null };
  }
  const qk = mapDraftKindToQuotaKind(draft.kind);

  // Bind each window on the minimum of the platform default and the
  // account's optional override.
  const dayQuota = checkQuota({
    platformLimit: limits[qk].perDay,
    accountLimit: account?.dailyLimit,
    used: usage[qk].day,
  });
  const weekQuota = checkQuota({
    platformLimit: limits[qk].perWeek,
    accountLimit: account?.weeklyLimit,
    used: usage[qk].week,
  });

  // Use `>` (strict) because `getAccountUsage` is computed BEFORE the new
  // `sent_at` row exists; the post-flip count would be `usage[qk].day + 1`.
  // We want to log "over quota" only when the just-completed send pushed the
  // total *past* the limit.
  const overDay = usage[qk].day + 1 > dayQuota.limit;
  const overWeek = usage[qk].week + 1 > weekQuota.limit;

  // A breach that is only over the platform-wide default (not the tighter
  // per-account override) stays a soft, log-only signal - see the function
  // docstring. A breach of the binding per-account override blocks the send.
  if (overDay && dayQuota.kind === 'account') {
    return {
      kind: 'quota_exceeded',
      window: 'day',
      quotaKind: qk,
      limit: dayQuota.limit,
      used: usage[qk].day + 1,
    };
  }
  if (overWeek && weekQuota.kind === 'account') {
    return {
      kind: 'quota_exceeded',
      window: 'week',
      quotaKind: qk,
      limit: weekQuota.limit,
      used: usage[qk].week + 1,
    };
  }

  const quotaEventDetails =
    overDay || overWeek
      ? {
          quotaExceeded: true,
          kind: qk,
          usage: { day: usage[qk].day + 1, week: usage[qk].week + 1 },
          limit: limits[qk],
        }
      : null;

  return { kind: 'ok', quotaEventDetails };
}
