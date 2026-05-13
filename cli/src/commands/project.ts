import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { DESCRIPTION_SCAFFOLD } from '@pitchbox/shared/project-extraction';
import { SCENARIO_META, RecommendationItemSchema } from '@pitchbox/shared/campaigns';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { stat, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ok, fail } from '../lib/output.js';
import { shallowClone } from '../lib/git-clone.js';

type Source =
  | { kind: 'folder'; value: string }
  | { kind: 'git'; value: string }
  | { kind: 'upload'; value: string };

export function registerProjectCommands(program: Command) {
  program
    .command('project:extract:start')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const runId = Number(opts.run);
      if (!Number.isInteger(runId)) return fail('invalid run id');
      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      if (run.kind !== 'project_extraction')
        return fail(`run ${runId} is not a project_extraction run`);
      if (!run.projectId) return fail(`run ${runId} has no project_id`);

      const [project] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, run.projectId));
      if (!project) return fail(`project ${run.projectId} not found`);

      const source = (run.params as { source?: Source }).source;
      if (!source) return fail('run has no source in params');

      let sourcePath: string;
      if (source.kind === 'folder') {
        if (!isAbsolute(source.value)) return fail('folder path must be absolute');
        const s = await stat(source.value).catch(() => null);
        if (!s || !s.isDirectory())
          return fail(`folder ${source.value} is not a readable directory`);
        sourcePath = source.value;
      } else if (source.kind === 'git') {
        sourcePath = `/tmp/pitchbox-extract-${runId}`;
        await rm(sourcePath, { recursive: true, force: true });
        await shallowClone(source.value, sourcePath);
      } else if (source.kind === 'upload') {
        if (!isAbsolute(source.value)) return fail('upload path must be absolute');
        const s = await stat(source.value).catch(() => null);
        if (!s || !s.isDirectory())
          return fail(`upload ${source.value} is not a readable directory`);
        sourcePath = source.value;
      } else {
        return fail(`unsupported source kind: ${(source as { kind: string }).kind}`);
      }

      const scenarios = SCENARIO_META.map((s) => ({
        slug: s.slug,
        label: s.label,
        description: s.description,
      }));
      const existingCampaigns = await loadExistingCampaigns(db, project.id);

      ok({
        runId,
        projectId: project.id,
        sourcePath,
        scaffoldTemplate: DESCRIPTION_SCAFFOLD,
        currentDescription: project.description ?? '',
        scenarios,
        existingCampaigns,
      });
    });

  program
    .command('project:extract:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const runId = Number(opts.run);
      if (!Number.isInteger(runId)) return fail('invalid run id');
      const raw = await readStdin();
      if (!raw || !raw.trim()) return fail('empty markdown on stdin');

      // Detect shape: JSON object with `description` field, else legacy raw markdown.
      let description: string;
      let rawRecommendations: unknown[] = [];
      try {
        const maybeJson = JSON.parse(raw);
        if (
          maybeJson &&
          typeof maybeJson === 'object' &&
          typeof (maybeJson as { description?: unknown }).description === 'string'
        ) {
          description = (maybeJson as { description: string }).description;
          const recs = (maybeJson as { recommendations?: unknown }).recommendations;
          if (Array.isArray(recs)) {
            rawRecommendations = recs;
          } else if (recs !== undefined) {
            process.stderr.write('[warn] recommendations is not an array; ignoring\n');
          }
        } else {
          description = raw;
        }
      } catch {
        // Not JSON - treat as legacy markdown.
        description = raw;
      }

      if (!description.trim()) return fail('empty markdown on stdin');

      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      if (run.kind !== 'project_extraction')
        return fail(`run ${runId} is not a project_extraction run`);
      if (!run.projectId) return fail(`run ${runId} has no project_id`);

      // Validate recommendations per-item; drop invalid.
      const validRecs: Array<{ scenarioSlug: string; name: string; objective: string }> = [];
      for (let i = 0; i < rawRecommendations.length; i++) {
        const parsed = RecommendationItemSchema.safeParse(rawRecommendations[i]);
        if (parsed.success) {
          validRecs.push(parsed.data);
        } else {
          const issues = parsed.error.issues
            .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
            .join('; ');
          process.stderr.write(`[warn] recommendation[${i}] dropped: ${issues}\n`);
        }
      }
      let capped = validRecs;
      if (capped.length > 10) {
        process.stderr.write(`[warn] recommendations capped from ${capped.length} to 10\n`);
        capped = capped.slice(0, 10);
      }

      await db.transaction(async (tx) => {
        await tx
          .update(schema.projects)
          .set({ description, updatedAt: new Date() })
          .where(eq(schema.projects.id, run.projectId!));
        await tx
          .delete(schema.campaignRecommendations)
          .where(eq(schema.campaignRecommendations.projectId, run.projectId!));
        if (capped.length > 0) {
          await tx.insert(schema.campaignRecommendations).values(
            capped.map((r) => ({
              projectId: run.projectId!,
              scenarioSlug: r.scenarioSlug,
              name: r.name,
              objective: r.objective,
            })),
          );
        }
        await tx
          .update(schema.runs)
          .set({ status: 'success', finishedAt: new Date() })
          .where(eq(schema.runs.id, runId));
      });

      // Best-effort cleanup of any temp dir created for the run.
      const source = (run.params as { source?: { kind: string; value?: string } }).source;
      if (source?.kind === 'git') {
        await rm(`/tmp/pitchbox-extract-${runId}`, { recursive: true, force: true }).catch(
          () => {},
        );
      } else if (source?.kind === 'upload' && typeof source.value === 'string') {
        await rm(source.value, { recursive: true, force: true }).catch(() => {});
      }

      ok({
        runId,
        projectId: run.projectId,
        bytes: description.length,
        recommendations: capped.length,
      });
    });

  // Reads recent drafts/messages for a project so the project-insighter
  // playbook can produce a Markdown summary without touching the DB directly.
  program
    .command('project:insights:context')
    .requiredOption('--project <id>', 'project id')
    .action(async (opts: { project: string }) => {
      const projectId = Number(opts.project);
      if (!Number.isInteger(projectId)) return fail('invalid project id');
      const db = getDb();
      const [project] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId));
      if (!project) return fail(`project ${projectId} not found`);

      const drafts = await db
        .select({
          id: schema.drafts.id,
          state: schema.drafts.state,
          kind: schema.drafts.kind,
          createdAt: schema.drafts.createdAt,
        })
        .from(schema.drafts)
        .where(eq(schema.drafts.projectId, projectId))
        .orderBy(desc(schema.drafts.createdAt))
        .limit(200);

      // Join via drafts so we only pull messages tied to this project's drafts.
      const draftIds = drafts.map((d) => d.id);
      const messages =
        draftIds.length === 0
          ? []
          : await db
              .select({
                id: schema.messages.id,
                draftId: schema.messages.draftId,
                isFromUs: schema.messages.isFromUs,
                createdAtPlatform: schema.messages.createdAtPlatform,
              })
              .from(schema.messages)
              .where(inArray(schema.messages.draftId, draftIds))
              .orderBy(desc(schema.messages.createdAtPlatform))
              .limit(200);

      ok({
        projectId,
        projectName: project.name,
        draftCount: drafts.length,
        replyCount: messages.filter((m) => !m.isFromUs).length,
        drafts,
        messages,
      });
    });

  // Persists a generated summary into `project_insights`. The playbook emits
  // `{summaryMd, evidence}` on stdout; this command writes one row.
  program
    .command('project:insights')
    .requiredOption('--project <id>', 'project id')
    .action(async (opts: { project: string }) => {
      const projectId = Number(opts.project);
      if (!Number.isInteger(projectId)) return fail('invalid project id');
      const raw = await readStdin();
      if (!raw || !raw.trim()) return fail('empty payload on stdin');
      let payload: { summaryMd?: unknown; evidence?: unknown };
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail('payload is not valid JSON');
      }
      const summaryMd =
        typeof payload.summaryMd === 'string' ? payload.summaryMd : String(payload.summaryMd ?? '');
      if (!summaryMd.trim()) return fail('summaryMd missing');
      const evidence =
        payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : {};
      const db = getDb();
      const [row] = await db
        .insert(schema.projectInsights)
        .values({ projectId, summaryMd, evidence: evidence as Record<string, unknown> })
        .returning({
          id: schema.projectInsights.id,
          generatedAt: schema.projectInsights.generatedAt,
        });
      ok({ id: row.id, projectId, generatedAt: row.generatedAt });
    });
}

async function loadExistingCampaigns(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<Array<{ id: number; name: string; scenarioSlug: string; objective: string }>> {
  const campaigns = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      scenarioSlug: schema.campaigns.skillSlug,
    })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.projectId, projectId));

  const out: Array<{ id: number; name: string; scenarioSlug: string; objective: string }> = [];
  for (const c of campaigns) {
    const [lastRun] = await db
      .select({ params: schema.runs.params })
      .from(schema.runs)
      .where(
        and(eq(schema.runs.campaignId, c.id), eq(schema.runs.kind, 'campaign_skill_generation')),
      )
      .orderBy(desc(schema.runs.startedAt))
      .limit(1);
    const objective = (lastRun?.params as { objective?: string } | null)?.objective ?? '';
    out.push({ id: c.id, name: c.name, scenarioSlug: c.scenarioSlug, objective });
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
