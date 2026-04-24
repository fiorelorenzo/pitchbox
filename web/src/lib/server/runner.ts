import { ClaudeCodeRunner } from '@pitchbox/shared/agents/claude-code';
import { getDb, schema } from './db.js';
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { emit } from './events.js';

const PITCHBOX_ROOT = process.env.PITCHBOX_ROOT
	? resolve(process.env.PITCHBOX_ROOT)
	: process.cwd();

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

	runner
		.run({
			playbookPath: playbook,
			slug: campaign.skillSlug,
			env: {
				PITCHBOX_CAMPAIGN_ID: String(campaignId),
				PITCHBOX_RUN_ID: String(run.id),
				PITCHBOX_ROOT,
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
