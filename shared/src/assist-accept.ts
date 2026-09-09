// Writes an accepted in-page suggestion into the assist plane's own ledger
// (#521). Until 2026-09-09 this materialised a `drafts` row and a `runs` row
// of kind `assist` purely because `drafts.run_id` was NOT NULL - borrowing a
// campaign-shaped bookkeeping unit for a plane that has no campaign, no run
// and no draft state machine of its own (see the historical shape in
// `shared/src/db/migrations/0013_assist_run_kind.sql`, now reversed by
// `shared/src/db/migrations/0021_assist_accepted_suggestions.sql`). A
// suggestion is ephemeral until the human accepts it
// (`web/src/lib/server/suggest.ts`); this is the other half - the accept
// path - and it deliberately walks the same checks
// `cli/src/commands/drafts.ts`'s `createDrafts` applies to a campaign draft
// (blocklist, contact dedup, `checkUncontactable`), so a suggestion Pitchbox
// helped write is never invisible to quota, contact history or analytics
// (docs/linkedin-integration-design.md, "Bookkeeping").
//
// What does NOT survive from the borrowed campaign path, by decision
// (#521): the per-account draft quota. The assist plane already has its own
// per-device and per-org rate limits (`web/src/routes/api/extension/suggest`)
// and the plan's own suggestions-per-period ceiling; what actually needs
// bounding is money, which `assist_usage` already ledgers per suggestion
// regardless of accept. There is therefore no `accounts` row and no
// `no_account` refusal on this path anymore either - the campaign `accounts`
// table has nothing left to answer here.
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client.js';
import { isBlocklisted, isKeywordBlocklisted } from './blocklist.js';
import {
  checkContactDedup,
  checkUncontactable,
  parseDedupPolicy,
  DEFAULT_DEDUP_POLICY,
} from './contact-dedup.js';
import { loadOperatorProfile } from './operator-profile.js';
import { resolvePricingForRunner, computeCostUsd } from './runlog/usage.js';
import type { DraftKind } from './quota-types.js';

export interface AcceptSuggestionUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
}

export interface AcceptSuggestionInput {
  organizationId: number;
  /** Context only (#523): the product this suggestion is about, if any.
   * Null files the suggestion under no project at all. */
  projectId: number | null;
  platformId: number;
  kind: DraftKind;
  /** Null for a kind whose audience is public rather than one person (e.g. a
   * top-level `post`), so no blocklist/dedup/contact-history check applies. */
  authorHandle: string | null;
  authorName?: string | null;
  postUrn?: string | null;
  postUrl?: string | null;
  body: string;
  /** The model's own draft text, kept only when the human changed it before
   * accepting - omit or pass the same value as `body` when they did not. */
  editedFrom?: string | null;
  deviceId: number | null;
  agentRunner: string;
  usage?: AcceptSuggestionUsage | null;
}

export type AcceptSuggestionRefusal =
  | { reason: 'blocked'; detail: string | null }
  | { reason: 'uncontactable'; detail: string | null }
  | { reason: 'recently_contacted'; priorContactedAt: string };

export type AcceptSuggestionResult =
  | { ok: true; id: number; dedupWarning: string | null }
  | { ok: false; refusal: AcceptSuggestionRefusal };

// A suggestion accepted before the human's own LinkedIn profile was ever
// captured has no operator handle to record - contact_history.account_handle
// is NOT NULL, and this is the honest placeholder rather than an invented
// identity. Once `operator_profiles` has a row (LI-21), every later accept
// records the real one.
const UNKNOWN_OPERATOR_HANDLE = 'unknown-operator';

/**
 * Validate an accepted suggestion against the same gates a campaign draft
 * goes through, then write it into the assist plane's own ledger
 * (`assist_accepted_suggestions`) plus a `contact_history` row, in one
 * transaction. Every check below runs before the transaction opens, so a
 * refusal leaves no partial write behind.
 */
export async function acceptSuggestion(
  db: Db,
  input: AcceptSuggestionInput,
): Promise<AcceptSuggestionResult> {
  if (input.authorHandle) {
    const r = await isBlocklisted(db, {
      platformId: input.platformId,
      projectId: input.projectId,
      targetUser: input.authorHandle,
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
  if (input.authorHandle) {
    // #335: a DM target already known to reject message requests is skipped
    // outright, ahead of the ordinary dedup window below. LinkedIn never
    // produces a `dm` suggestion (quota ships at zero, no scenario), but this
    // keeps the accept path a genuine superset of createDrafts rather than a
    // LinkedIn-only special case.
    if (input.kind === 'dm') {
      const uncontactableCheck = await checkUncontactable(db, {
        platformId: input.platformId,
        targetUser: input.authorHandle,
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
      targetUser: input.authorHandle,
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

  // #522: usage here is a client-reported block - the extension's own copy
  // of the `usage` a /suggest `done` event carried, echoed back because a
  // suggestion is never persisted server-side until accept. The
  // authoritative spend figure lives in `assist_usage`, written from the
  // server's own AgentRunner result the moment the suggestion's stream
  // finished (web/src/routes/api/extension/suggest/+server.ts) - never from
  // the client - so both what the device reported and what this repo's own
  // price table recomputes from its token counts are kept here for audit (a
  // device that lies is visible, not authoritative), never read back into a
  // budget decision.
  const pricing = resolvePricingForRunner(input.agentRunner, undefined);
  const recomputedCostUsd = input.usage
    ? computeCostUsd(
        {
          inputTokens: input.usage.inputTokens ?? undefined,
          outputTokens: input.usage.outputTokens ?? undefined,
          cacheReadTokens: input.usage.cacheReadTokens ?? undefined,
          cacheCreationTokens: input.usage.cacheCreationTokens ?? undefined,
        },
        pricing,
      )
    : null;
  const reportedCostUsd = input.usage?.costUsd ?? null;

  const operatorProfile = await loadOperatorProfile(db, input.organizationId);
  const accountHandle = operatorProfile?.handle ?? UNKNOWN_OPERATOR_HANDLE;

  const written = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.assistAcceptedSuggestions)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        platformId: input.platformId,
        deviceId: input.deviceId,
        kind: input.kind,
        postUrn: input.postUrn ?? null,
        authorHandle: input.authorHandle,
        authorName: input.authorName ?? null,
        postUrl: input.postUrl ?? null,
        body: input.body,
        editedFrom:
          input.editedFrom != null && input.editedFrom !== input.body ? input.editedFrom : null,
        agentRunner: input.agentRunner,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        cacheReadTokens: input.usage?.cacheReadTokens ?? null,
        cacheCreationTokens: input.usage?.cacheCreationTokens ?? null,
        reportedCostUsd: reportedCostUsd != null ? reportedCostUsd.toFixed(4) : null,
        recomputedCostUsd: recomputedCostUsd != null ? recomputedCostUsd.toFixed(4) : null,
      })
      .returning({ id: schema.assistAcceptedSuggestions.id });

    // #521: recorded unconditionally on accept, not gated behind a later
    // "sent" detection the assist plane never actually wired for the
    // in-page panel (unlike a draft opened from the Inbox) - a suggestion
    // inserted into LinkedIn's own composer is the moment Lorenzo decided
    // this counts as contact, so a campaign will not DM someone the
    // assistant just answered in public.
    if (input.authorHandle) {
      await tx.insert(schema.contactHistory).values({
        platformId: input.platformId,
        accountHandle,
        targetUser: input.authorHandle,
        organizationId: input.organizationId,
      });
    }

    return { id: row.id };
  });

  return { ok: true, id: written.id, dedupWarning };
}
