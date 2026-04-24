import { ClaudeCodeRunner } from '@pitchbox/shared/agents/claude-code';
import { getDb, schema } from './db.js';
import { eq } from 'drizzle-orm';
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

export async function runCampaign(campaignId: number): Promise<{ runId: number }> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId, trigger: 'manual', status: 'running' })
    .returning();

  emit('run:started', { runId: run.id, campaignId });

  const runner = new ClaudeCodeRunner();
  const playbook = resolve(PITCHBOX_ROOT, 'playbooks', `${campaign.skillSlug}.md`);

  // Prepend our bin/ so playbooks can call `pitchbox <cmd>` directly.
  const augmentedPath = `${PITCHBOX_ROOT}/bin:${process.env.PATH ?? ''}`;

  runner
    .run({
      playbookPath: playbook,
      slug: campaign.skillSlug,
      env: {
        PITCHBOX_CAMPAIGN_ID: String(campaignId),
        PITCHBOX_RUN_ID: String(run.id),
        PITCHBOX_ROOT,
        PATH: augmentedPath,
      },
      cwd: PITCHBOX_ROOT,
      timeoutMs: 15 * 60 * 1000,
      onLogLine: (line) => emit('run:log', { runId: run.id, line }),
    })
    .then(async (res) => {
      await db
        .update(schema.runs)
        .set({
          status: res.exitCode === 0 ? 'success' : 'failed',
          finishedAt: new Date(),
          stdoutLogPath: res.logPath,
          tokensUsed: res.tokensUsed ?? null,
        })
        .where(eq(schema.runs.id, run.id));
      emit('run:finished', { runId: run.id, exitCode: res.exitCode });
      emit('drafts:changed', {});
    })
    .catch(async (err) => {
      await db
        .update(schema.runs)
        .set({ status: 'failed', finishedAt: new Date(), error: String(err) })
        .where(eq(schema.runs.id, run.id));
      emit('run:finished', { runId: run.id, exitCode: 1, error: String(err) });
    });

  return { runId: run.id };
}
