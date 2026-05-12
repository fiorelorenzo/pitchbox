import { createAgentRunner } from '@pitchbox/shared/agents/registry';
import { loadRunnerConfig } from '@pitchbox/shared/agents/config';
import type { AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { notify } from '@pitchbox/shared/notifications';
import { classifyFailure } from '@pitchbox/shared/runlog/classify-failure';
import type { ParsedEvent, EventKind, EventPayload } from '@pitchbox/shared/runlog/types';
import { getDb, schema } from './db.js';
import { and, eq } from 'drizzle-orm';
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
        const patch: { tokensUsed?: number; stdoutLogPath?: string } = {};
        if (current.tokensUsed == null && res.tokensUsed != null) patch.tokensUsed = res.tokensUsed;
        if (current.stdoutLogPath == null && res.logPath) patch.stdoutLogPath = res.logPath;
        if (Object.keys(patch).length > 0) {
          await db.update(schema.runs).set(patch).where(eq(schema.runs.id, run.id));
        }
        // Skip onFinish in the cancellation path — cancelRun handles its own emit.
        if (finalStatus !== 'cancelled') opts.onFinish?.(finalStatus);
        emit('run:finished', {
          runId: run.id,
          campaignId: run.campaignId,
          projectId: run.projectId,
          exitCode: finalStatus === 'success' ? 0 : 1,
          error: finalStatus === 'cancelled' ? 'cancelled by user' : undefined,
        });
        if (isCampaignRun && finalStatus === 'success') emit('drafts:changed', {});
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
      if (isCampaignRun && res.exitCode === 0) emit('drafts:changed', {});
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
        if (isCampaignRun && finalStatus === 'success') emit('drafts:changed', {});
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
          // Re-read the run row to check terminal status — the CLI's `extract:finish`
          // handles cleanup on success; we only own the failure/cancellation path.
          const [latest] = await db
            .select({ status: schema.runs.status })
            .from(schema.runs)
            .where(eq(schema.runs.id, run.id));
          if (latest && latest.status !== 'success') {
            await rm(params.source.value, { recursive: true, force: true }).catch(() => {});
          }
        }
      } catch {
        // Never let cleanup throw out of finally.
      }
    });
}

export async function runCampaign(
  campaignId: number,
  trigger: string = 'manual',
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  if (campaign.status === 'draft') {
    throw new Error(`campaign ${campaignId} is still draft — generate the profile first`);
  }

  // Application-level guard: look up an existing running run and short-circuit.
  const [existing] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.status, 'running')))
    .limit(1);
  if (existing) {
    return { runId: existing.id, alreadyRunning: true };
  }

  // DB-level safety net: a partial unique index on (campaign_id) WHERE status='running'
  // prevents two concurrent INSERTs from both succeeding if they race past the SELECT above.
  // Snapshot the playbook body at run-creation time so later edits to the
  // playbook never retroactively change past runs. Missing rows fall back to
  // the on-disk file at dispatch.
  const [pb] = await db
    .select({ body: schema.playbooks.body })
    .from(schema.playbooks)
    .where(eq(schema.playbooks.slug, campaign.skillSlug));

  let run: typeof schema.runs.$inferSelect;
  try {
    [run] = await db
      .insert(schema.runs)
      .values({
        campaignId,
        agentRunner: campaign.agentRunner,
        trigger,
        status: 'running',
        playbookBody: pb?.body ?? null,
      })
      .returning();
  } catch (err) {
    // Unique violation on the partial index → someone else just inserted a running run.
    // Drizzle wraps the underlying pg error; check code in a few places and fall back
    // to matching the constraint name in the message.
    const e = err as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
      message?: string;
    };
    const code = e?.code ?? e?.cause?.code;
    const constraint = e?.constraint ?? e?.cause?.constraint;
    const message = e?.message ?? String(err);
    const isUniqueViolation =
      code === '23505' ||
      constraint === 'runs_one_running_per_campaign' ||
      message.includes('runs_one_running_per_campaign');

    if (isUniqueViolation) {
      const [raced] = await db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.campaignId, campaignId), eq(schema.runs.status, 'running')))
        .limit(1);
      if (raced) return { runId: raced.id, alreadyRunning: true };
    }
    throw err;
  }

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

export async function runCampaignSkillGeneration(
  campaignId: number,
  scenario: 'reddit-scout' | 'reddit-commenter',
  objective: string,
  trigger: string = 'manual',
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
      params: { scenario, objective },
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
