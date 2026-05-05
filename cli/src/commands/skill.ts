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
}
