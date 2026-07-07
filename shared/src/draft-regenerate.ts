// Stub regeneration helper for issue #22. A future iteration will invoke the
// runner in `regenerate-single` mode to actually rewrite the draft body using
// the supplied hint; today we increment the counter, persist the hint, and
// append a `regenerated` draft_event so the inbox can display the audit trail.
import { eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { drafts, draftEvents, draftRegenerationHints, runs } from './db/schema.js';

export interface RegenerateDraftInput {
  draftId: number;
  hint?: string | null;
  authorUserId?: number | null;
  actor?: string;
}

export interface RegenerateDraftResult {
  draftId: number;
  regenerationCount: number;
  hintId: number | null;
}

export async function regenerateDraft(
  db: Db,
  input: RegenerateDraftInput,
): Promise<RegenerateDraftResult> {
  const { draftId } = input;
  const [updated] = await db
    .update(drafts)
    .set({
      regenerationCount: sql`${drafts.regenerationCount} + 1`,
      version: sql`${drafts.version} + 1`,
    })
    .where(eq(drafts.id, draftId))
    .returning({ regenerationCount: drafts.regenerationCount });

  let hintId: number | null = null;
  if (input.hint && input.hint.trim().length > 0) {
    const [row] = await db
      .insert(draftRegenerationHints)
      .values({
        draftId,
        hintText: input.hint,
        authorUserId: input.authorUserId ?? null,
      })
      .returning({ id: draftRegenerationHints.id });
    hintId = row.id;
  }

  await db.insert(draftEvents).values({
    draftId,
    event: 'regenerated',
    actor: input.actor ?? 'user',
    details: {
      hint: input.hint ?? null,
      hintId,
      regenerationCount: updated?.regenerationCount ?? null,
    },
  });

  return {
    draftId,
    regenerationCount: updated?.regenerationCount ?? 0,
    hintId,
  };
}

export interface StartDraftRegenerationInput {
  draftId: number;
  hint?: string | null;
  authorUserId?: number | null;
}

export interface StartDraftRegenerationResult {
  run: typeof runs.$inferSelect;
  alreadyRunning: boolean;
}

/**
 * Prepare a draft_regeneration run for a pending draft: guard against a
 * concurrent regeneration, snapshot the runner + campaign from the run that
 * created the draft, insert the run row, flag the draft as regenerating, and
 * persist the reviewer hint. The caller (web dispatcher) then spawns the agent.
 */
export async function startDraftRegeneration(
  db: Db,
  input: StartDraftRegenerationInput,
): Promise<StartDraftRegenerationResult> {
  const { draftId } = input;
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId));
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.state !== 'pending_review')
    throw new Error(
      `draft ${draftId} is ${draft.state}; only pending_review drafts can be regenerated`,
    );

  // Single-flight: if a regeneration run is still running for this draft, return it.
  if (draft.regeneratingRunId != null) {
    const [existing] = await db.select().from(runs).where(eq(runs.id, draft.regeneratingRunId));
    if (existing && existing.status === 'running') {
      return { run: existing, alreadyRunning: true };
    }
  }

  // Inherit campaign + runner from the run that created this draft.
  const [origin] = await db.select().from(runs).where(eq(runs.id, draft.runId));
  const agentRunner = origin?.agentRunner ?? 'claude-code';
  const campaignId = origin?.campaignId ?? null;

  const hint = input.hint && input.hint.trim().length > 0 ? input.hint.trim() : null;

  const [run] = await db
    .insert(runs)
    .values({
      kind: 'draft_regeneration',
      campaignId,
      projectId: draft.projectId,
      agentRunner,
      trigger: 'manual',
      status: 'running',
      params: { draftId, hint },
    })
    .returning();

  await db.update(drafts).set({ regeneratingRunId: run.id }).where(eq(drafts.id, draftId));

  if (hint) {
    await db
      .insert(draftRegenerationHints)
      .values({ draftId, hintText: hint, authorUserId: input.authorUserId ?? null });
  }

  return { run, alreadyRunning: false };
}

/** Clear the in-flight regeneration flag (used by the dispatcher on fail/cancel). */
export async function clearDraftRegeneration(db: Db, draftId: number): Promise<void> {
  await db.update(drafts).set({ regeneratingRunId: null }).where(eq(drafts.id, draftId));
}
