import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { describeScenarioSchema, getSchema, type ScenarioSlug } from '@pitchbox/shared/campaigns';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

type GenParams = { scenario: ScenarioSlug; objective: string };

export function registerSkillCommands(program: Command) {
  program
    .command('skill:generate:start')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const runId = Number(opts.run);
      if (!Number.isInteger(runId)) return fail('invalid run id');
      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      if (run.kind !== 'campaign_skill_generation')
        return fail(`run ${runId} is not a campaign_skill_generation run`);
      if (!run.campaignId) return fail(`run ${runId} has no campaign_id`);

      const [campaign] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, run.campaignId));
      if (!campaign) return fail(`campaign ${run.campaignId} not found`);
      const [project] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, campaign.projectId));
      if (!project) return fail(`project ${campaign.projectId} not found`);

      const params = run.params as GenParams | null;
      if (!params || !params.scenario || !params.objective)
        return fail('run params must include scenario and objective');

      // Sanity: schema must exist for this scenario
      void getSchema(params.scenario);

      ok({
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
      });
    });

  program
    .command('skill:generate:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const runId = Number(opts.run);
      if (!Number.isInteger(runId)) return fail('invalid run id');
      const raw = await readStdin();
      if (!raw || !raw.trim()) return fail('empty payload on stdin');

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return fail(`stdin is not valid JSON: ${(e as Error).message}`);
      }

      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      if (run.kind !== 'campaign_skill_generation')
        return fail(`run ${runId} is not a campaign_skill_generation run`);
      if (!run.campaignId) return fail(`run ${runId} has no campaign_id`);

      const [campaign] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, run.campaignId));
      if (!campaign) return fail(`campaign ${run.campaignId} not found`);

      const scenario = (run.params as { scenario?: string } | null)?.scenario as
        | ScenarioSlug
        | undefined;
      if (!scenario) return fail('run.params.scenario missing');

      const schema0 = getSchema(scenario);
      const result = schema0.safeParse(payload);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        await db
          .update(schema.runs)
          .set({ status: 'failed', finishedAt: new Date(), error: `validation: ${issues}` })
          .where(eq(schema.runs.id, runId));
        return fail(`profile failed validation: ${issues}`);
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
            generatedConfig: result.data,
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
            .set({ config: result.data, status: nextStatus })
            .where(eq(schema.campaigns.id, run.campaignId!));
          const nextParams = {
            ...(run.params as Record<string, unknown> | null),
            generatedConfig: result.data,
            previousConfig: campaign.config ?? null,
            adopted: true,
          };
          await tx
            .update(schema.runs)
            .set({ status: 'success', finishedAt: new Date(), params: nextParams })
            .where(eq(schema.runs.id, runId));
        }
      });

      ok({ runId, campaignId: run.campaignId, status: 'success' });
    });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
