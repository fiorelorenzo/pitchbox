import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { describeScenarioSchema, getSchema, type ScenarioSlug } from '@pitchbox/shared/campaigns';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

type GenParams = { scenario: ScenarioSlug; objective: string };

// Core skill-generation logic, extracted so both the CLI and the Pitchbox MCP
// server share it. Returns data (or throws); never touches process exit.

export async function skillGenerateStart(runId: number) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'campaign_skill_generation')
    throw new Error(`run ${runId} is not a campaign_skill_generation run`);
  if (!run.campaignId) throw new Error(`run ${runId} has no campaign_id`);

  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, run.campaignId));
  if (!campaign) throw new Error(`campaign ${run.campaignId} not found`);
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, campaign.projectId));
  if (!project) throw new Error(`project ${campaign.projectId} not found`);

  const params = run.params as GenParams | null;
  if (!params || !params.scenario || !params.objective)
    throw new Error('run params must include scenario and objective');

  return {
    runId,
    campaignId: campaign.id,
    scenario: params.scenario,
    objective: params.objective,
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description ?? '',
    },
    schemaPromptDescription: describeScenarioSchema(params.scenario),
    existingConfig: campaign.config ?? null,
  };
}

export async function skillGenerateFinish(runId: number, payload: unknown) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'campaign_skill_generation')
    throw new Error(`run ${runId} is not a campaign_skill_generation run`);
  if (!run.campaignId) throw new Error(`run ${runId} has no campaign_id`);

  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, run.campaignId));
  if (!campaign) throw new Error(`campaign ${run.campaignId} not found`);

  const scenario = (run.params as { scenario?: string } | null)?.scenario as
    ScenarioSlug | undefined;
  if (!scenario) throw new Error('run.params.scenario missing');

  const schema0 = getSchema(scenario);
  // Scenarios without a registered structured schema (e.g. mastodon-*) accept
  // the generated payload as-is - same "accepted as-is" stance as
  // getCampaignReadiness, since there's nothing to validate it against yet.
  let generatedProfile: unknown = payload;
  if (schema0) {
    const result = schema0.safeParse(payload);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      await db
        .update(schema.runs)
        .set({ status: 'failed', finishedAt: new Date(), error: `validation: ${issues}` })
        .where(eq(schema.runs.id, runId));
      throw new Error(`profile failed validation: ${issues}`);
    }
    generatedProfile = result.data;
  }

  // Preview mode: stash the generated profile + previous config on the run
  // (params.generatedConfig / params.previousConfig) and let the user
  // adopt/discard it from the UI. Apply mode (default) writes it straight
  // into campaigns.config - preserves the legacy behaviour used by the
  // "Regenerate profile" dialog.
  const mode = (run.params as { mode?: string } | null)?.mode ?? 'apply';
  await db.transaction(async (tx) => {
    if (mode === 'preview') {
      const nextParams = {
        ...(run.params as Record<string, unknown> | null),
        generatedConfig: generatedProfile,
        previousConfig: campaign.config ?? null,
      };
      await tx
        .update(schema.runs)
        .set({ status: 'success', finishedAt: new Date(), params: nextParams })
        .where(eq(schema.runs.id, runId));
    } else {
      const nextStatus = campaign.status === 'draft' ? 'active' : campaign.status;
      await tx
        .update(schema.campaigns)
        .set({ config: generatedProfile, status: nextStatus })
        .where(eq(schema.campaigns.id, run.campaignId!));
      const nextParams = {
        ...(run.params as Record<string, unknown> | null),
        generatedConfig: generatedProfile,
        previousConfig: campaign.config ?? null,
        adopted: true,
      };
      await tx
        .update(schema.runs)
        .set({ status: 'success', finishedAt: new Date(), params: nextParams })
        .where(eq(schema.runs.id, runId));
    }
  });

  return { runId, campaignId: run.campaignId, status: 'success' as const };
}

export function registerSkillCommands(program: Command) {
  program
    .command('skill:generate:start')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      try {
        ok(await skillGenerateStart(Number(opts.run)));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('skill:generate:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const raw = await readStdin();
      if (!raw || !raw.trim()) return fail('empty payload on stdin');
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return fail(`stdin is not valid JSON: ${(e as Error).message}`);
      }
      try {
        ok(await skillGenerateFinish(Number(opts.run), payload));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
