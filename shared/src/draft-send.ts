import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { isBlocklisted } from './blocklist.js';
import { getAccountUsage, isDraftKind, loadQuotaLimits, mapDraftKindToQuotaKind } from './quota.js';

export type DraftLike = {
  platformId: number;
  projectId: number;
  accountId: number;
  targetUser: string | null;
  kind: string;
};

export type SendEvaluation =
  | { kind: 'blocked'; reason: string | null }
  | { kind: 'ok'; quotaEventDetails: Record<string, unknown> | null };

/**
 * Decide whether a draft can transition to `sent`, and (if yes) compute the
 * `draft_events.details` payload describing any quota breach. The function
 * does not write anything — callers own DB mutations.
 *
 * NOTE on the +1: `getAccountUsage` reads `drafts.sent_at` from the DB.
 * Callers invoke this helper BEFORE writing the new `sent_at`, so the count
 * we compute is "drafts already sent BEFORE this one". To detect whether THIS
 * send pushes the account over the cap we add 1. We use strict `>` so that
 * exactly-at-limit counts (e.g. day=10, perDay=10 after +1=11) correctly
 * trigger an over-quota event.
 */
export async function evaluateDraftSend(
  db: Db,
  draft: DraftLike,
  now: Date = new Date(),
): Promise<SendEvaluation> {
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
  const usage = await getAccountUsage(db, draft.accountId, now);
  const limits = await loadQuotaLimits(db, platform?.slug ?? 'reddit');

  if (!isDraftKind(draft.kind)) {
    // Unknown kind — no quota applies; treat as unrestricted
    return { kind: 'ok', quotaEventDetails: null };
  }
  const qk = mapDraftKindToQuotaKind(draft.kind);

  // Use `>` (strict) because `getAccountUsage` is computed BEFORE the new
  // `sent_at` row exists; the post-flip count would be `usage[qk].day + 1`.
  // We want to log "over quota" only when the just-completed send pushed the
  // total *past* the limit.
  const overDay = usage[qk].day + 1 > limits[qk].perDay;
  const overWeek = usage[qk].week + 1 > limits[qk].perWeek;

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
