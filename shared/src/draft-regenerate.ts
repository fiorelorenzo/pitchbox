import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { drafts, draftEvents, draftRegenerationHints, runs } from './db/schema.js';

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

/**
 * Clear the in-flight regeneration flag, but only if the draft still points at
 * `runId` (a newer regeneration may have taken over). Returns whether it cleared.
 */
export async function clearDraftRegenerationIfOwned(
  db: Db,
  draftId: number,
  runId: number,
): Promise<boolean> {
  const [d] = await db
    .select({ regeneratingRunId: drafts.regeneratingRunId })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  if (d && d.regeneratingRunId === runId) {
    await db.update(drafts).set({ regeneratingRunId: null }).where(eq(drafts.id, draftId));
    return true;
  }
  return false;
}

export type UndoDraftRegenerationResult =
  { kind: 'ok'; draftId: number; version: number } | { kind: 'conflict'; currentVersion: number };

/**
 * Restore the single previous body captured by the last `regenerated` event.
 * Only valid while the draft is still pending_review and not mid-regeneration.
 *
 * `expectedVersion` guards the update with an optimistic-lock check (mirrors
 * `updateDraftWithVersion` in web/src/lib/server/draft-state.ts): if the draft
 * was mutated (edited, approved, sent, ...) between the caller's read and this
 * call, the version predicate matches zero rows and a `conflict` result is
 * returned instead of silently clobbering the concurrent write.
 */
export async function undoDraftRegeneration(
  db: Db,
  draftId: number,
  expectedVersion: number,
  opts: { actor?: string } = {},
): Promise<UndoDraftRegenerationResult> {
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId));
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.state !== 'pending_review')
    throw new Error(`draft ${draftId} is ${draft.state}; cannot undo`);
  if (draft.regeneratingRunId != null)
    throw new Error(`draft ${draftId} is regenerating; cannot undo yet`);

  // The regeneration to undo: the latest 'regenerated' event carrying a previous body.
  const [latestRegen] = await db
    .select()
    .from(draftEvents)
    .where(and(eq(draftEvents.draftId, draftId), eq(draftEvents.event, 'regenerated')))
    .orderBy(desc(draftEvents.id))
    .limit(1);
  const details = (latestRegen?.details ?? {}) as {
    previousBody?: string;
    previousTitle?: string | null;
  };
  if (!latestRegen || typeof details.previousBody !== 'string')
    throw new Error(`draft ${draftId} has no previous body to restore`);
  // Guard: don't undo the same regeneration twice. If the latest 'regeneration_undone'
  // event is newer than that 'regenerated' event, this regeneration was already undone
  // (a manual edit or anything else in between must not re-trigger a restore).
  const [latestUndone] = await db
    .select({ id: draftEvents.id })
    .from(draftEvents)
    .where(and(eq(draftEvents.draftId, draftId), eq(draftEvents.event, 'regeneration_undone')))
    .orderBy(desc(draftEvents.id))
    .limit(1);
  if (latestUndone && latestUndone.id > latestRegen.id)
    throw new Error(`draft ${draftId} regeneration already undone`);

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(drafts)
      .set({
        body: details.previousBody,
        title: details.previousTitle ?? draft.title,
        version: sql`${drafts.version} + 1`,
      })
      .where(and(eq(drafts.id, draftId), eq(drafts.version, expectedVersion)))
      .returning({ version: drafts.version });

    if (!updated) {
      const [fresh] = await tx
        .select({ version: drafts.version })
        .from(drafts)
        .where(eq(drafts.id, draftId));
      return { kind: 'conflict', currentVersion: fresh?.version ?? expectedVersion };
    }

    await tx.insert(draftEvents).values({
      draftId,
      event: 'regeneration_undone',
      actor: opts.actor ?? 'user',
      details: { restoredFromEventId: latestRegen.id },
    });

    return { kind: 'ok', draftId, version: updated.version };
  });
}
