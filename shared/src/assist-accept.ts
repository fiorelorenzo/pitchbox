// Materialises an accepted in-page suggestion (LI-16, #313) into the same
// ledger a campaign draft lands in. A suggestion is ephemeral until the human
// accepts it (web/src/lib/server/suggest.ts): no runs row, no draft. This is
// the other half - the accept path - and it deliberately walks the same
// checks `cli/src/commands/drafts.ts`'s `createDrafts` applies to a campaign
// draft (blocklist, contact dedup, `checkUncontactable`), so a suggestion
// Pitchbox helped write is never invisible to quota, contact history or
// analytics (docs/linkedin-integration-design.md, "Bookkeeping").
//
// `drafts.run_id` is NOT NULL, so rather than making that column nullable
// this creates a `runs` row of kind = 'assist' (project-targeted, no
// campaign) to hang the draft off - see the `runs_kind_target_chk` migration
// (shared/src/db/migrations/0013_assist_run_kind.sql) and
// shared/src/runlog/contract.ts (an assist run has no playbook and no finish
// tool, so it is written already terminal, in the same transaction as the
// draft, and is deliberately absent from `PLAYBOOK_FINISH_TOOL`).
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { isBlocklisted, isKeywordBlocklisted, isSubredditBlocklisted } from './blocklist.js';
import {
  checkContactDedup,
  checkUncontactable,
  parseDedupPolicy,
  DEFAULT_DEDUP_POLICY,
} from './contact-dedup.js';
import { checkQuota, getAccountUsage, loadQuotaLimits, mapDraftKindToQuotaKind } from './quota.js';
import type { DraftKind } from './quota-types.js';

export interface AcceptSuggestionUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
}

export interface AcceptSuggestionInput {
  projectId: number;
  organizationId: number;
  platformId: number;
  kind: DraftKind;
  /** Null for a kind whose audience is public rather than one person (e.g. a
   * top-level `post`), so no blocklist/dedup/contact-history check applies. */
  targetUser: string | null;
  body: string;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  agentRunner: string;
  usage?: AcceptSuggestionUsage | null;
  /** Extra context recorded on the `runs.params` jsonb, for analytics/debugging. */
  runParams?: Record<string, unknown>;
}

export type AcceptSuggestionRefusal =
  | { reason: 'no_account' }
  | { reason: 'blocked'; detail: string | null }
  | { reason: 'uncontactable'; detail: string | null }
  | { reason: 'recently_contacted'; priorContactedAt: string }
  | { reason: 'quota_exhausted'; window: 'day'; limit: number; used: number };

export type AcceptSuggestionResult =
  | { ok: true; draftId: number; runId: number; dedupWarning: string | null }
  | { ok: false; refusal: AcceptSuggestionRefusal };

/**
 * Validate an accepted suggestion against the same gates a campaign draft
 * goes through, then write the `runs` + `drafts` (+ `draft_events`) rows in
 * one transaction. Every check below runs before the transaction opens, so a
 * refusal leaves neither row behind - "no partial write" from #313's
 * acceptance criteria.
 */
export async function acceptSuggestionIntoDraft(
  db: Db,
  input: AcceptSuggestionInput,
): Promise<AcceptSuggestionResult> {
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.projectId, input.projectId),
        eq(schema.accounts.platformId, input.platformId),
        eq(schema.accounts.active, true),
      ),
    )
    .limit(1);
  if (!account) return { ok: false, refusal: { reason: 'no_account' } };

  if (input.targetUser) {
    const r = await isBlocklisted(db, {
      platformId: input.platformId,
      projectId: input.projectId,
      targetUser: input.targetUser,
    });
    if (r.blocked) return { ok: false, refusal: { reason: 'blocked', detail: r.reason } };
  }

  // Subreddit blocklist: mirrors createDrafts for parity, though LinkedIn
  // metadata never carries `subreddit` - this only ever fires for a future
  // platform that reuses this path and does.
  const subreddit = typeof input.metadata?.subreddit === 'string' ? input.metadata.subreddit : null;
  if ((input.kind === 'post' || input.kind === 'post_comment') && subreddit) {
    const r = await isSubredditBlocklisted(db, {
      platformId: input.platformId,
      projectId: input.projectId,
      subreddit,
    });
    if (r.blocked) return { ok: false, refusal: { reason: 'blocked', detail: r.reason } };
  }

  if (input.body.trim()) {
    const r = await isKeywordBlocklisted(db, {
      platformId: input.platformId,
      projectId: input.projectId,
      text: input.body,
    });
    if (r.blocked) return { ok: false, refusal: { reason: 'blocked', detail: r.reason } };
  }

  let dedupWarning: string | null = null;
  if (input.targetUser) {
    // #335: a DM target already known to reject message requests is skipped
    // outright, ahead of the ordinary dedup window below. LinkedIn never
    // produces a `dm` suggestion (quota ships at zero, no scenario), but this
    // keeps the accept path a genuine superset of createDrafts rather than a
    // LinkedIn-only special case.
    if (input.kind === 'dm') {
      const uncontactableCheck = await checkUncontactable(db, {
        platformId: input.platformId,
        targetUser: input.targetUser,
        organizationId: input.organizationId,
      });
      if (uncontactableCheck.uncontactable) {
        return {
          ok: false,
          refusal: { reason: 'uncontactable', detail: uncontactableCheck.reason },
        };
      }
    }

    const [policyRow] = await db
      .select()
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, 'dedup_policy'));
    const dedupPolicy = policyRow ? parseDedupPolicy(policyRow.value) : { ...DEFAULT_DEDUP_POLICY };
    const dedup = await checkContactDedup(db, {
      platformId: input.platformId,
      targetUser: input.targetUser,
      windowDays: dedupPolicy.windowDays,
      organizationId: input.organizationId,
    });
    if (dedup.withinWindow && dedup.priorContactedAt) {
      if (dedupPolicy.mode === 'skip') {
        return {
          ok: false,
          refusal: {
            reason: 'recently_contacted',
            priorContactedAt: dedup.priorContactedAt.toISOString(),
          },
        };
      }
      dedupWarning = `Previously contacted on ${dedup.priorContactedAt.toISOString()} (within ${dedupPolicy.windowDays}d window).`;
    }
  }

  // Quota: a precondition here for the same reason it is one for /suggest -
  // accepting what cannot be sent wastes the human's edit and the draft would
  // just sit blocked at send time. Only the day window: /suggest's own
  // precondition checks day only, and the week window still gates at send
  // through evaluateDraftSend.
  const [platform] = await db
    .select({ slug: schema.platforms.slug })
    .from(schema.platforms)
    .where(eq(schema.platforms.id, input.platformId));
  const [limits, usage] = await Promise.all([
    loadQuotaLimits(db, platform?.slug ?? 'reddit'),
    getAccountUsage(db, account.id),
  ]);
  const quotaKind = mapDraftKindToQuotaKind(input.kind);
  const day = checkQuota({
    platformLimit: limits[quotaKind].perDay,
    accountLimit: account.dailyLimit,
    used: usage[quotaKind].day,
  });
  if (day.remaining <= 0) {
    return {
      ok: false,
      refusal: { reason: 'quota_exhausted', window: 'day', limit: day.limit, used: day.used },
    };
  }

  const costUsd = input.usage?.costUsd != null ? input.usage.costUsd.toFixed(4) : null;

  const written = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(schema.runs)
      .values({
        kind: 'assist',
        campaignId: null,
        projectId: input.projectId,
        agentRunner: input.agentRunner,
        trigger: 'manual',
        // Terminal on write: an assist run has no agent that could call a
        // finish tool (shared/src/runlog/contract.ts), so it must never sit
        // in `running` waiting for one, or it reads as `playbook_incomplete`.
        status: 'success',
        finishedAt: new Date(),
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        cacheReadTokens: input.usage?.cacheReadTokens ?? null,
        cacheCreationTokens: input.usage?.cacheCreationTokens ?? null,
        costUsd,
        params: input.runParams ?? {},
      })
      .returning({ id: schema.runs.id });

    const [draft] = await tx
      .insert(schema.drafts)
      .values({
        runId: run.id,
        projectId: input.projectId,
        platformId: input.platformId,
        accountId: account.id,
        kind: input.kind,
        state: 'pending_review',
        targetUser: input.targetUser,
        body: input.body,
        sourceRef: input.sourceRef ?? {},
        metadata: input.metadata ?? {},
        dedupWarning,
      })
      .returning({ id: schema.drafts.id });

    await tx.insert(schema.draftEvents).values({
      draftId: draft.id,
      event: 'created',
      actor: 'system',
      details: {},
    });

    return { runId: run.id, draftId: draft.id };
  });

  return { ok: true, draftId: written.draftId, runId: written.runId, dedupWarning };
}
