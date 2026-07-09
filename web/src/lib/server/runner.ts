import { createAgentRunner } from '@pitchbox/shared/agents/registry';
import { loadRunnerConfig } from '@pitchbox/shared/agents/config';
import type { AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { notify } from '@pitchbox/shared/notifications';
import { classifyFailure } from '@pitchbox/shared/runlog/classify-failure';
import type { ParsedEvent, EventKind, EventPayload } from '@pitchbox/shared/runlog/types';
import { withCampaignLock } from '@pitchbox/shared/scheduler/dispatch-lock';
import {
  startDraftRegeneration,
  clearDraftRegenerationIfOwned,
} from '@pitchbox/shared/draft-regenerate';
import { startReplyDrafting } from '@pitchbox/shared/reply-drafter';
import { getDb, schema } from './db.js';
import { and, desc, eq } from 'drizzle-orm';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { emit } from './events.js';

// Derive repo root from this module's location (web/src/lib/server/runner.ts → ../../../..).
// Honour PITCHBOX_ROOT only when it's an absolute path; relative values like "." would
// resolve against the dev server CWD (web/) and miss the playbooks/ directory.
const DERIVED_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const PITCHBOX_ROOT =
  process.env.PITCHBOX_ROOT && isAbsolute(process.env.PITCHBOX_ROOT)
    ? process.env.PITCHBOX_ROOT
    : DERIVED_ROOT;

// Track active cancel functions by runId so callers can stop them.
const runCancels = new Map<number, () => void>();

const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled']);

/**
 * Load every persisted run_event row for `runId` and reshape it into
 * `ParsedEvent[]` so the failure classifier can scan it. Used only on the
 * failure path so the cost is bounded to the events the run actually emitted.
 */
async function loadParsedEvents(runId: number): Promise<ParsedEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      seq: schema.runEvents.seq,
      kind: schema.runEvents.kind,
      payload: schema.runEvents.payload,
      raw: schema.runEvents.raw,
    })
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId));
  return rows.map((r) => ({
    seq: r.seq,
    kind: r.kind as EventKind,
    payload: r.payload as EventPayload,
    raw: r.raw,
  }));
}

/**
 * Classify a failed run by reading its persisted events plus an extra hint
 * (typically the runner's own error string when no events were emitted).
 */
async function classifyFailedRun(
  runId: number,
  exitCode: number | null,
  extraHint?: string,
): Promise<ReturnType<typeof classifyFailure>> {
  const events = await loadParsedEvents(runId);
  if (extraHint && extraHint.trim().length > 0) {
    events.push({
      seq: -1,
      kind: 'unknown',
      payload: { type: 'unknown', eventType: 'runner-error', raw: extraHint },
      raw: extraHint,
    });
  }
  return classifyFailure(events, exitCode);
}

// Clear the draft_regeneration in-flight flag for a run's draft, but only if the
// draft still points at THIS run. Called both when runner creation fails early
// (before the finally chain is registered) and in the terminal finally, so a
// draft never stays stuck showing "regenerating" with no run behind it.
async function clearRegenFlag(
  db: ReturnType<typeof getDb>,
  run: typeof schema.runs.$inferSelect,
): Promise<void> {
  if (run.kind !== 'draft_regeneration') return;
  const draftId = (run.params as { draftId?: number } | null)?.draftId;
  if (!draftId) return;
  const cleared = await clearDraftRegenerationIfOwned(db, draftId, run.id);
  if (cleared) emit('drafts:changed', {});
}

// Reply drafting keeps drafting_run_id set on failure (so the placeholder stays
// non-approvable); this refreshes the inbox to the run's current status on every
// terminal outcome (success, failure, or an early runner-creation failure), so
// the UI flips from the spinner to the drafted body or the Retry state.
function refreshReplyDraft(run: typeof schema.runs.$inferSelect): void {
  if (run.kind === 'reply_drafting') emit('drafts:changed', {});
}

/**
 * Kind-agnostic dispatcher: spawns an agent runner for a pre-inserted run row,
 * wires up the stdout dedup pipeline, and updates the run's terminal state.
 *
 * Callers (`runCampaign`, `runProjectExtraction`) are responsible for:
 *   - inserting the `runs` row,
 *   - emitting `run:started`,
 *   - choosing the playbook slug + extra env.
 */
async function dispatchRun(
  run: typeof schema.runs.$inferSelect,
  opts: {
    playbookSlug: string;
    extraEnv: Record<string, string>;
    onFinish?: (status: 'success' | 'failed' | 'cancelled') => void;
  },
): Promise<void> {
  const db = getDb();

  let runner: ReturnType<typeof createAgentRunner>;
  try {
    const config = await loadRunnerConfig(db, run.agentRunner as AgentRunnerSlug);
    runner = createAgentRunner(run.agentRunner, config);
  } catch (err) {
    const errMsg = String(err instanceof Error ? err.message : err);
    const failureReason = await classifyFailedRun(run.id, 1, errMsg);
    await db
      .update(schema.runs)
      .set({ status: 'failed', finishedAt: new Date(), error: errMsg, failureReason })
      .where(eq(schema.runs.id, run.id));
    opts.onFinish?.('failed');
    emit('run:finished', {
      runId: run.id,
      campaignId: run.campaignId,
      projectId: run.projectId,
      exitCode: 1,
      error: errMsg,
    });
    await clearRegenFlag(db, run);
    refreshReplyDraft(run);
    return;
  }

  // Prefer the run's snapshot (set at run-creation time) over the on-disk file.
  // The on-disk file remains the fallback for legacy runs and for project
  // extraction / skill generation which don't have rows in the playbooks table.
  let playbook = resolve(PITCHBOX_ROOT, 'playbooks', `${opts.playbookSlug}.md`);
  if (run.playbookBody) {
    const tmpDir = resolve(PITCHBOX_ROOT, 'daemon', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    playbook = resolve(tmpDir, `run-${run.id}-${opts.playbookSlug}.md`);
    await writeFile(playbook, run.playbookBody, 'utf8');
  }

  // Prepend our bin/ so playbooks can call `pitchbox <cmd>` directly.
  const augmentedPath = `${PITCHBOX_ROOT}/bin:${process.env.PATH ?? ''}`;

  // Per-run dedup state: claude -p sometimes emits multiple `system.init` events
  // sharing the same session_id, plus an intermediate `result` before the final one.
  // Show only the FIRST init for a given session_id and only the LAST result (held
  // back until the process exits) so the timeline doesn't look like the run restarted
  // and completed twice.
  const seenSessionIds = new Set<string>();
  let pendingResultEvent: { seq: number; kind: string; payload: unknown; raw: string } | null =
    null;

  const insertEvent = async (pe: { seq: number; kind: string; payload: unknown; raw: string }) => {
    const [row] = await db
      .insert(schema.runEvents)
      .values({
        runId: run.id,
        seq: pe.seq,
        kind: pe.kind,
        payload: pe.payload,
        raw: pe.raw,
      })
      .returning();
    emit('run:log', {
      runId: run.id,
      event: {
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        payload: row.payload,
        ts: row.createdAt,
        raw: pe.raw,
      },
    });
  };

  const handle = runner.run({
    playbookPath: playbook,
    slug: opts.playbookSlug,
    env: {
      PITCHBOX_RUN_ID: String(run.id),
      PITCHBOX_ROOT,
      PATH: augmentedPath,
      ...opts.extraEnv,
    },
    cwd: PITCHBOX_ROOT,
    timeoutMs: 15 * 60 * 1000,

    onRawLine: () => {
      // Raw lines are already persisted to the runner's log file; no-op here.
    },

    onParsedEvents: async (parsed) => {
      for (const pe of parsed) {
        if (pe.kind === 'session') {
          const sid = (pe.payload as { sessionId?: string } | null)?.sessionId;
          if (sid) {
            if (seenSessionIds.has(sid)) continue;
            seenSessionIds.add(sid);
          }
        }
        if (pe.kind === 'result') {
          // Hold the latest result; commit only when the process exits.
          pendingResultEvent = pe;
          continue;
        }
        await insertEvent(pe);
      }
    },
  });

  runCancels.set(run.id, handle.cancel);

  const flushPendingResult = async () => {
    if (pendingResultEvent) {
      await insertEvent(pendingResultEvent);
      pendingResultEvent = null;
    }
  };

  // `drafts:changed` is only relevant for campaign runs (project_extraction never
  // produces drafts). Emit it strictly on a successful campaign run.
  const isCampaignRun = run.kind === 'campaign';
  // Campaign and draft_regeneration runs both change drafts; emit on success.
  const emitsDrafts = isCampaignRun || run.kind === 'draft_regeneration';

  handle.result
    .then(async (res) => {
      await flushPendingResult();
      // If the run is already in a terminal state (cancelled by user OR
      // pre-marked by the playbook via `pitchbox run:finish`), don't overwrite it.
      const [current] = await db
        .select({
          status: schema.runs.status,
          tokensUsed: schema.runs.tokensUsed,
          stdoutLogPath: schema.runs.stdoutLogPath,
        })
        .from(schema.runs)
        .where(eq(schema.runs.id, run.id));
      if (current && TERMINAL_STATUSES.has(current.status)) {
        const finalStatus = current.status as 'success' | 'failed' | 'cancelled';
        // Backfill metadata that the CLI doesn't know (token count, stdout log path),
        // without disturbing the terminal status the playbook already committed to.
        const patch: {
          tokensUsed?: number;
          stdoutLogPath?: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
          costUsd?: string;
        } = {};
        if (current.tokensUsed == null && res.tokensUsed != null) patch.tokensUsed = res.tokensUsed;
        if (current.stdoutLogPath == null && res.logPath) patch.stdoutLogPath = res.logPath;
        if (res.usage) {
          patch.inputTokens = res.usage.inputTokens;
          patch.outputTokens = res.usage.outputTokens;
          patch.cacheReadTokens = res.usage.cacheReadTokens;
          patch.cacheCreationTokens = res.usage.cacheCreationTokens;
          patch.costUsd = res.usage.costUsd.toFixed(4);
        }
        if (Object.keys(patch).length > 0) {
          await db.update(schema.runs).set(patch).where(eq(schema.runs.id, run.id));
        }
        // Skip onFinish in the cancellation path - cancelRun handles its own emit.
        if (finalStatus !== 'cancelled') opts.onFinish?.(finalStatus);
        emit('run:finished', {
          runId: run.id,
          campaignId: run.campaignId,
          projectId: run.projectId,
          exitCode: finalStatus === 'success' ? 0 : 1,
          error: finalStatus === 'cancelled' ? 'cancelled by user' : undefined,
        });
        if (emitsDrafts && finalStatus === 'success') emit('drafts:changed', {});
        return;
      }
      const finalStatus: 'success' | 'failed' = res.exitCode === 0 ? 'success' : 'failed';
      const failureReason =
        finalStatus === 'failed' ? await classifyFailedRun(run.id, res.exitCode) : null;
      await db
        .update(schema.runs)
        .set({
          status: finalStatus,
          finishedAt: new Date(),
          stdoutLogPath: res.logPath,
          tokensUsed: res.tokensUsed ?? null,
          inputTokens: res.usage?.inputTokens ?? null,
          outputTokens: res.usage?.outputTokens ?? null,
          cacheReadTokens: res.usage?.cacheReadTokens ?? null,
          cacheCreationTokens: res.usage?.cacheCreationTokens ?? null,
          costUsd: res.usage ? res.usage.costUsd.toFixed(4) : null,
          failureReason,
        })
        .where(eq(schema.runs.id, run.id));
      opts.onFinish?.(finalStatus);
      emit('run:finished', {
        runId: run.id,
        campaignId: run.campaignId,
        projectId: run.projectId,
        exitCode: res.exitCode,
      });
      if (emitsDrafts && res.exitCode === 0) emit('drafts:changed', {});
      await notify(db, {
        kind: `run.${finalStatus}`,
        title: `Run #${run.id} ${finalStatus}`,
        body: isCampaignRun ? `Campaign ${run.campaignId} run finished.` : undefined,
        payload: { runId: run.id, campaignId: run.campaignId, projectId: run.projectId },
        severity: finalStatus === 'success' ? 'success' : 'error',
      });
    })
    .catch(async (err) => {
      await flushPendingResult();
      const [current] = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, run.id));
      if (current && TERMINAL_STATUSES.has(current.status)) {
        const finalStatus = current.status as 'success' | 'failed' | 'cancelled';
        if (finalStatus !== 'cancelled') opts.onFinish?.(finalStatus);
        emit('run:finished', {
          runId: run.id,
          campaignId: run.campaignId,
          projectId: run.projectId,
          exitCode: finalStatus === 'success' ? 0 : 1,
          error: finalStatus === 'cancelled' ? 'cancelled by user' : undefined,
        });
        if (emitsDrafts && finalStatus === 'success') emit('drafts:changed', {});
        return;
      }
      const failureReason = await classifyFailedRun(run.id, 1, String(err));
      await db
        .update(schema.runs)
        .set({ status: 'failed', finishedAt: new Date(), error: String(err), failureReason })
        .where(eq(schema.runs.id, run.id));
      opts.onFinish?.('failed');
      emit('run:finished', {
        runId: run.id,
        campaignId: run.campaignId,
        projectId: run.projectId,
        exitCode: 1,
        error: String(err),
      });
      await notify(db, {
        kind: 'run.failed',
        title: `Run #${run.id} failed`,
        body: String(err),
        payload: { runId: run.id, campaignId: run.campaignId, projectId: run.projectId },
        severity: 'error',
      });
    })
    .finally(async () => {
      runCancels.delete(run.id);
      try {
        const params = run.params as { source?: { kind?: string; value?: string } } | null;
        if (
          run.kind === 'project_extraction' &&
          params?.source?.kind === 'upload' &&
          typeof params.source.value === 'string'
        ) {
          // Re-read the run row to check terminal status - the CLI's `extract:finish`
          // handles cleanup on success; we only own the failure/cancellation path.
          const [latest] = await db
            .select({ status: schema.runs.status })
            .from(schema.runs)
            .where(eq(schema.runs.id, run.id));
          if (latest && latest.status !== 'success') {
            await rm(params.source.value, { recursive: true, force: true }).catch(() => {});
          }
        }
        // On success draft_regen_finish already cleared the flag; this covers
        // the failed/cancelled paths so the inbox stops showing "regenerating".
        await clearRegenFlag(db, run);
        refreshReplyDraft(run);
      } catch {
        // Never let cleanup throw out of finally.
      }
    });
}

export async function runCampaign(
  campaignId: number,
  trigger: string = 'manual',
  scheduledFor: Date | null = null,
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  if (campaign.status === 'draft') {
    throw new Error(`campaign ${campaignId} is still draft - generate the profile first`);
  }

  const [pb] = await db
    .select({ body: schema.playbooks.body })
    .from(schema.playbooks)
    .where(eq(schema.playbooks.slug, campaign.skillSlug));

  // Wrap the read-modify-write in a Postgres transaction-scoped advisory lock
  // keyed on `campaign:<id>`. Concurrent dispatches for the same campaign
  // serialise behind the lock; the loser sees the winner's `running` row and
  // short-circuits with `alreadyRunning: true`. The DB-level partial UNIQUE
  // index (status='running') and the new `(campaign_id, scheduled_for)`
  // partial UNIQUE index are the safety net if the lock is bypassed.
  const locked = await withCampaignLock(db, campaignId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.status, 'running')))
      .limit(1);
    if (existing) {
      return { runId: existing.id, alreadyRunning: true } as const;
    }

    // If this is a scheduled dispatch, an idempotency check on
    // (campaign_id, scheduled_for) catches a concurrent scheduler that
    // already created the row for this tick.
    if (scheduledFor) {
      const [dup] = await tx
        .select()
        .from(schema.runs)
        .where(
          and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.scheduledFor, scheduledFor)),
        )
        .limit(1);
      if (dup) {
        return { runId: dup.id, alreadyRunning: true } as const;
      }
    }

    try {
      const [inserted] = await tx
        .insert(schema.runs)
        .values({
          campaignId,
          agentRunner: campaign.agentRunner,
          trigger,
          status: 'running',
          playbookBody: pb?.body ?? null,
          scheduledFor,
        })
        .returning();
      return { run: inserted } as const;
    } catch (err) {
      const e = err as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
        message?: string;
      };
      const code = e?.code ?? e?.cause?.code;
      const constraint = e?.constraint ?? e?.cause?.constraint;
      const message = e?.message ?? String(err);
      const isUniqueViolation = code === '23505';
      const isScheduledForViolation =
        isUniqueViolation &&
        (constraint === 'runs_campaign_scheduled_for_unique' ||
          message.includes('runs_campaign_scheduled_for_unique'));
      const isRunningViolation =
        isUniqueViolation &&
        (constraint === 'runs_one_running_per_campaign' ||
          message.includes('runs_one_running_per_campaign'));

      if (isScheduledForViolation) {
        // Tagged so the /api/run route can map it to a clean 409.
        const tagged = new Error('already_dispatched') as Error & { code: string };
        tagged.code = 'already_dispatched';
        throw tagged;
      }
      if (isRunningViolation) {
        const [raced] = await tx
          .select()
          .from(schema.runs)
          .where(and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.status, 'running')))
          .limit(1);
        if (raced) return { runId: raced.id, alreadyRunning: true } as const;
      }
      throw err;
    }
  });

  // Lock unavailable → another writer is mid-RMW for this campaign. Treat as
  // already-running so the caller doesn't double-fire.
  if (locked == null) {
    const [existing] = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.status, 'running')))
      .limit(1);
    if (existing) return { runId: existing.id, alreadyRunning: true };
    // Lost the lock AND no running row yet - surface the same 409 contract.
    const err = new Error('already_dispatched') as Error & { code: string };
    err.code = 'already_dispatched';
    throw err;
  }

  if ('runId' in locked && locked.runId != null) {
    return { runId: locked.runId, alreadyRunning: locked.alreadyRunning };
  }
  if (!('run' in locked) || !locked.run) {
    // Should be unreachable - the lock callback always returns one branch.
    throw new Error('dispatch returned no run');
  }
  const run = locked.run;

  emit('run:started', { runId: run.id, campaignId });

  await dispatchRun(run, {
    playbookSlug: campaign.skillSlug,
    extraEnv: { PITCHBOX_CAMPAIGN_ID: String(campaignId) },
  });

  return { runId: run.id };
}

export async function runProjectExtraction(
  projectId: number,
  source:
    | { kind: 'folder'; value: string }
    | { kind: 'git'; value: string }
    | { kind: 'upload'; value: string },
  trigger: string = 'manual',
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!project) throw new Error(`project ${projectId} not found`);

  // Application-level guard: only one extraction per project at a time. There is
  // no partial unique index for project_extraction runs (spec accepted this).
  const [existing] = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.kind, 'project_extraction'),
        eq(schema.runs.status, 'running'),
      ),
    )
    .limit(1);
  if (existing) return { runId: existing.id, alreadyRunning: true };

  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'project_extraction',
      projectId,
      agentRunner: project.defaultAgentRunner,
      trigger,
      status: 'running',
      params: { source },
    })
    .returning();

  emit('run:started', { runId: run.id, projectId });

  await dispatchRun(run, {
    playbookSlug: 'project-extractor',
    extraEnv: {},
    onFinish: (status) => {
      if (status === 'success') emit('project:description:updated', { projectId, runId: run.id });
    },
  });

  return { runId: run.id };
}

export async function runProjectInsights(
  projectId: number,
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!project) throw new Error(`project ${projectId} not found`);

  // Application-level guard: one running project_insights run per project. A
  // running run older than STALE_MS is presumed orphaned and superseded.
  const STALE_MS = 60 * 60_000;
  const runningFilter = and(
    eq(schema.runs.projectId, projectId),
    eq(schema.runs.kind, 'project_insights'),
    eq(schema.runs.status, 'running'),
  );
  const running = await db
    .select()
    .from(schema.runs)
    .where(runningFilter)
    .orderBy(desc(schema.runs.startedAt));
  const newest = running[0];
  if (newest && Date.now() - newest.startedAt.getTime() < STALE_MS) {
    return { runId: newest.id, alreadyRunning: true };
  }
  if (running.length > 0) {
    // All running rows are stale/orphaned; fail them so exactly one run stays live.
    await db
      .update(schema.runs)
      .set({ status: 'failed', finishedAt: new Date(), error: 'superseded (orphaned)' })
      .where(runningFilter);
  }

  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'project_insights',
      projectId,
      agentRunner: project.defaultAgentRunner,
      trigger: 'manual',
      status: 'running',
    })
    .returning();

  emit('run:started', { runId: run.id, projectId });

  await dispatchRun(run, {
    playbookSlug: 'project-insighter',
    extraEnv: { PITCHBOX_PROJECT_ID: String(projectId) },
    onFinish: (status) => {
      if (status === 'success') emit('project:insights:updated', { projectId, runId: run.id });
    },
  });

  return { runId: run.id };
}

export async function runDraftRegeneration(
  draftId: number,
  hint: string | null = null,
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const { run, alreadyRunning } = await startDraftRegeneration(db, { draftId, hint });
  if (alreadyRunning) return { runId: run.id, alreadyRunning: true };

  emit('drafts:changed', { id: draftId });
  emit('run:started', { runId: run.id, campaignId: run.campaignId, projectId: run.projectId });

  await dispatchRun(run, {
    playbookSlug: 'draft-regenerator',
    extraEnv: run.campaignId ? { PITCHBOX_CAMPAIGN_ID: String(run.campaignId) } : {},
  });

  return { runId: run.id };
}

export async function runReplyDrafting(
  replyDraftId: number,
  parentMessageId: number,
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const { run, alreadyRunning } = await startReplyDrafting(db, { replyDraftId, parentMessageId });
  if (alreadyRunning) return { runId: run.id, alreadyRunning: true };

  emit('drafts:changed', { id: replyDraftId });
  emit('run:started', { runId: run.id, campaignId: run.campaignId, projectId: run.projectId });

  await dispatchRun(run, {
    playbookSlug: 'reply-drafter',
    extraEnv: run.campaignId ? { PITCHBOX_CAMPAIGN_ID: String(run.campaignId) } : {},
  });

  return { runId: run.id };
}

export async function runCampaignSkillGeneration(
  campaignId: number,
  scenario: 'reddit-scout' | 'reddit-commenter',
  objective: string,
  trigger: string = 'manual',
  mode: 'apply' | 'preview' = 'apply',
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  const [existing] = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.campaignId, campaignId),
        eq(schema.runs.kind, 'campaign_skill_generation'),
        eq(schema.runs.status, 'running'),
      ),
    )
    .limit(1);
  if (existing) return { runId: existing.id, alreadyRunning: true };

  const [run] = await db
    .insert(schema.runs)
    .values({
      kind: 'campaign_skill_generation',
      campaignId,
      agentRunner: campaign.agentRunner,
      trigger,
      status: 'running',
      params: { scenario, objective, mode },
    })
    .returning();

  emit('run:started', { runId: run.id, campaignId });

  await dispatchRun(run, {
    playbookSlug: 'campaign-skill-generator',
    extraEnv: {},
  });

  return { runId: run.id };
}

/**
 * Cancel an in-progress run by runId.
 * Returns true if the run was found and cancelled, false if it was not running.
 */
export async function cancelRun(runId: number): Promise<boolean> {
  const cancel = runCancels.get(runId);
  if (!cancel) return false;

  cancel();
  runCancels.delete(runId);

  // Mark the run as cancelled (distinct from failed).
  const db = getDb();
  await db
    .update(schema.runs)
    .set({ status: 'cancelled', finishedAt: new Date(), error: 'cancelled by user' })
    .where(eq(schema.runs.id, runId));

  // Look up campaignId/projectId so the client can clear the running state.
  const [r] = await db
    .select({ campaignId: schema.runs.campaignId, projectId: schema.runs.projectId })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  emit('run:finished', {
    runId,
    campaignId: r?.campaignId ?? null,
    projectId: r?.projectId ?? null,
    exitCode: 1,
    error: 'cancelled by user',
  });

  return true;
}
