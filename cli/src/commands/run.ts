import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { getSchema, SCENARIO_META } from '@pitchbox/shared/campaigns';
import { loadActiveTemplates, type TemplateKind } from '@pitchbox/shared/templates';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

// Core run-lifecycle logic, extracted from the commander actions so it can be
// reused by both the `pitchbox` CLI and the Pitchbox MCP server. These functions
// return data (or throw) and never touch process exit. The run/campaign binding
// is passed in by the caller (env-derived) rather than read here, so the same
// code path serves a local run and a cloud session.

export async function startRun(campaignId: number, runId?: number | null) {
  if (!Number.isInteger(campaignId)) throw new Error('invalid campaign id');
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  const scenarioMeta = SCENARIO_META.find((s) => s.slug === campaign.skillSlug);
  if (scenarioMeta) {
    const validation = getSchema(
      campaign.skillSlug as 'reddit-scout' | 'reddit-commenter',
    ).safeParse(campaign.config);
    if (!validation.success) {
      throw new Error(
        'campaign profile is not in the structured format - regenerate it from the dashboard',
      );
    }
  }

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, campaign.projectId));
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.id, campaign.platformId));
  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.projectId, campaign.projectId));
  const blocks = await db
    .select()
    .from(schema.blocklist)
    .where(eq(schema.blocklist.platformId, campaign.platformId));
  const contacted = await db
    .select({ target: schema.contactHistory.targetUser })
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.platformId, campaign.platformId));

  // Few-shot templates (project-scoped). Filter by kind when the scenario
  // implies one - scout/commenter both produce comments, but DM-style
  // scenarios will read 'dm'. Keep it simple: load all active and let
  // the playbook pick.
  const inferredKind: TemplateKind | undefined =
    campaign.skillSlug === 'reddit-commenter' || campaign.skillSlug === 'reddit-scout'
      ? 'comment'
      : undefined;
  const templates = await loadActiveTemplates(db, {
    projectId: campaign.projectId,
    kind: inferredKind,
    campaignId: campaign.id,
  });

  // When a runId is supplied (e.g. the web server / daemon pre-created the run),
  // reuse that row instead of creating a second one - the DB partial unique
  // index would reject it, and run-start should be idempotent in that case.
  let run: typeof schema.runs.$inferSelect | undefined;
  if (runId && Number.isInteger(runId)) {
    [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (!run) throw new Error(`run ${runId} not found in runs table`);
    if (run.campaignId !== campaignId) {
      throw new Error(`run ${runId} belongs to campaign ${run.campaignId}, not ${campaignId}`);
    }
  } else {
    [run] = await db
      .insert(schema.runs)
      .values({ campaignId, trigger: 'manual', status: 'running' })
      .returning();
  }

  return {
    runId: run.id,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      skillSlug: campaign.skillSlug,
      config: campaign.config,
    },
    project: { id: project.id, slug: project.slug, name: project.name },
    platform: { id: platform.id, slug: platform.slug },
    accounts: accounts
      .filter((a) => a.platformId === campaign.platformId && a.active)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map((a) => ({ id: a.id, handle: a.handle, role: a.role, isDefault: a.isDefault })),
    blocklist: blocks.map((b) => ({ kind: b.kind, value: b.value })),
    contactedRecently: contacted.map((c) => c.target),
    templates: templates.map((t) => ({ id: t.id, kind: t.kind, title: t.title, body: t.body })),
  };
}

export async function finishRun(
  runId: number,
  status: 'success' | 'failed',
  extra?: { error?: string; tokens?: number },
): Promise<{ runId: number; status: 'success' | 'failed' }> {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  if (status !== 'success' && status !== 'failed') throw new Error('invalid status');
  const db = getDb();
  await db
    .update(schema.runs)
    .set({
      status,
      finishedAt: new Date(),
      error: extra?.error,
      tokensUsed: extra?.tokens,
    })
    .where(eq(schema.runs.id, runId));
  return { runId, status };
}

export function registerRunCommands(program: Command) {
  program
    .command('run:start')
    .requiredOption('--campaign <id>', 'campaign id')
    .action(async (opts: { campaign: string }) => {
      const envRunId = process.env.PITCHBOX_RUN_ID ? Number(process.env.PITCHBOX_RUN_ID) : null;
      try {
        ok(await startRun(Number(opts.campaign), envRunId));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('run:finish')
    .requiredOption('--run <id>', 'run id')
    .requiredOption('--status <status>', 'success | failed')
    .option('--error <msg>', 'error message')
    .option('--tokens <n>', 'tokens used')
    .action(async (opts: { run: string; status: string; error?: string; tokens?: string }) => {
      try {
        ok(
          await finishRun(Number(opts.run), opts.status as 'success' | 'failed', {
            error: opts.error,
            tokens: opts.tokens ? Number(opts.tokens) : undefined,
          }),
        );
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
