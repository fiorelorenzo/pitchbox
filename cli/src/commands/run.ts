import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

export function registerRunCommands(program: Command) {
  program
    .command('run:start')
    .requiredOption('--campaign <id>', 'campaign id')
    .action(async (opts: { campaign: string }) => {
      const campaignId = Number(opts.campaign);
      if (!Number.isInteger(campaignId)) return fail('invalid campaign id');
      const db = getDb();

      const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      if (!campaign) return fail(`campaign ${campaignId} not found`);

      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, campaign.projectId));
      const [platform] = await db.select().from(schema.platforms).where(eq(schema.platforms.id, campaign.platformId));
      const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.projectId, campaign.projectId));
      const configs = await db
        .select()
        .from(schema.projectConfigs)
        .where(eq(schema.projectConfigs.projectId, campaign.projectId));
      const blocks = await db
        .select()
        .from(schema.blocklist)
        .where(eq(schema.blocklist.platformId, campaign.platformId));
      const contacted = await db
        .select({ target: schema.contactHistory.targetUser })
        .from(schema.contactHistory)
        .where(eq(schema.contactHistory.platformId, campaign.platformId));

      const [run] = await db
        .insert(schema.runs)
        .values({ campaignId, trigger: 'manual', status: 'running' })
        .returning();

      const configMap: Record<string, unknown> = {};
      for (const c of configs) configMap[c.key] = c.value;

      ok({
        runId: run.id,
        campaign: { id: campaign.id, name: campaign.name, skillSlug: campaign.skillSlug, config: campaign.config },
        project: { id: project.id, slug: project.slug, name: project.name },
        platform: { id: platform.id, slug: platform.slug },
        config: configMap,
        accounts: accounts.map((a) => ({ id: a.id, handle: a.handle, role: a.role })),
        blocklist: blocks.map((b) => ({ kind: b.kind, value: b.value })),
        contactedRecently: contacted.map((c) => c.target),
      });
    });

  program
    .command('run:finish')
    .requiredOption('--run <id>', 'run id')
    .requiredOption('--status <status>', 'success | failed')
    .option('--error <msg>', 'error message')
    .option('--tokens <n>', 'tokens used')
    .action(async (opts: { run: string; status: string; error?: string; tokens?: string }) => {
      const runId = Number(opts.run);
      if (!Number.isInteger(runId)) return fail('invalid run id');
      if (opts.status !== 'success' && opts.status !== 'failed') return fail('invalid status');
      const db = getDb();
      await db
        .update(schema.runs)
        .set({
          status: opts.status,
          finishedAt: new Date(),
          error: opts.error,
          tokensUsed: opts.tokens ? Number(opts.tokens) : undefined,
        })
        .where(eq(schema.runs.id, runId));
      ok({ runId, status: opts.status });
    });
}
