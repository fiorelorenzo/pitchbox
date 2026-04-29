import { createAgentRunner } from '@pitchbox/shared/agents/registry';
import { getDb, schema } from './db.js';
import { and, eq } from 'drizzle-orm';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    runner = createAgentRunner(run.agentRunner);
  } catch (err) {
    const errMsg = String(err instanceof Error ? err.message : err);
    await db
      .update(schema.runs)
      .set({ status: 'failed', finishedAt: new Date(), error: errMsg })
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

  const playbook = resolve(PITCHBOX_ROOT, 'playbooks', `${opts.playbookSlug}.md`);

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
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, run.id));
      if (current && TERMINAL_STATUSES.has(current.status)) {
        const finalStatus = current.status as 'success' | 'failed' | 'cancelled';
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
      await db
        .update(schema.runs)
        .set({
          status: finalStatus,
          finishedAt: new Date(),
          stdoutLogPath: res.logPath,
          tokensUsed: res.tokensUsed ?? null,
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
      await db
        .update(schema.runs)
        .set({ status: 'failed', finishedAt: new Date(), error: String(err) })
        .where(eq(schema.runs.id, run.id));
      opts.onFinish?.('failed');
      emit('run:finished', {
        runId: run.id,
        campaignId: run.campaignId,
        projectId: run.projectId,
        exitCode: 1,
        error: String(err),
      });
    })
    .finally(() => {
      runCancels.delete(run.id);
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
  let run: typeof schema.runs.$inferSelect;
  try {
    [run] = await db
      .insert(schema.runs)
      .values({
        campaignId,
        agentRunner: campaign.agentRunner,
        trigger,
        status: 'running',
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
  source: { kind: 'folder'; value: string } | { kind: 'git'; value: string },
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
