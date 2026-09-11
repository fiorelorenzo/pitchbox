import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { DESCRIPTION_SCAFFOLD } from '@pitchbox/shared/project-extraction';
import { SCENARIO_META, RecommendationItemSchema } from '@pitchbox/shared/campaigns';
import { listProjectSources, type ProjectSourceRow } from '@pitchbox/shared/project-sources';
import {
  viewProjectSourceForAgent,
  SOURCE_CONTENT_MAX_CHARS,
} from '@pitchbox/shared/project-source-content';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { readFile, readdir, realpath, stat, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ok, fail } from '../lib/output.js';
import { shallowClone } from '../lib/git-clone.js';

/**
 * Directories never worth showing an extraction agent: build output, vendored
 * dependencies and VCS internals bury the handful of files that actually
 * describe the product, and on a big repo they alone blow the listing cap.
 */
const SKIP_DIRS: Record<string, true> = {
  '.git': true,
  node_modules: true,
  dist: true,
  build: true,
  out: true,
  target: true,
  vendor: true,
  coverage: true,
  '.next': true,
  '.svelte-kit': true,
  '.turbo': true,
  '.venv': true,
  __pycache__: true,
};

/** Listing cap. A tree past this is already too big to reason about file by file. */
const MAX_LIST_ENTRIES = 2_000;

/** Read cap, in bytes. Enough for any README/manifest; keeps one Read from
 * flooding the agent's context (and the run log) with a generated bundle. */
const MAX_READ_BYTES = 200_000;

/** The kinds whose content is a directory the agent walks, rather than a
 * cached read `project_extract_sources` hands over as text. */
const TREE_KINDS = ['folder', 'git', 'upload'] as const;
type TreeSourceKind = (typeof TREE_KINDS)[number];

function isTreeSource(source: ProjectSourceRow): source is ProjectSourceRow & {
  kind: TreeSourceKind;
} {
  return (TREE_KINDS as readonly string[]).includes(source.kind);
}

/** Load the extraction run behind a source-access call, or explain why it isn't one. */
async function loadExtractionRun(runId: number): Promise<typeof schema.runs.$inferSelect> {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  const [run] = await getDb().select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'project_extraction')
    throw new Error(`run ${runId} is not a project_extraction run`);
  return run;
}

/**
 * The run's project plus every active source on it. A description run reads
 * the project's whole source set (#431/#434 replaced the one-source-per-run
 * model): the human curates the set in the dashboard, the agent reads all
 * of it, so adding a second source does not mean choosing which one counts.
 */
async function loadRunContext(run: typeof schema.runs.$inferSelect): Promise<{
  project: typeof schema.projects.$inferSelect;
  sources: ProjectSourceRow[];
}> {
  const db = getDb();
  if (!run.projectId) throw new Error(`run ${run.id} has no project_id`);
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId));
  if (!project) throw new Error(`project ${run.projectId} not found`);
  const sources = await listProjectSources(db, project.organizationId, project.id);
  return { project, sources: sources.filter((s) => s.active) };
}

/**
 * Where one tree source lives ON THE CLIENT. A `git` source is cloned once
 * per run into a path keyed by run and source, so a project with two
 * repositories keeps them apart and a second `files`/`read` call on the
 * same source costs nothing. `folder`/`upload` are already paths.
 *
 * A clone failure is thrown, not swallowed: the caller is a tool call the
 * agent made about this specific source, and it has other sources to fall
 * back on.
 */
const clonedRoots = new Map<string, string>();

async function resolveTreeSourcePath(
  run: typeof schema.runs.$inferSelect,
  source: ProjectSourceRow,
): Promise<string> {
  const config = (source.config ?? {}) as Record<string, unknown>;
  const value = typeof config.value === 'string' ? config.value.trim() : '';
  if (!value) throw new Error(`source ${source.id} carries no path or URL`);

  if (source.kind === 'git') {
    const key = `${run.id}:${source.id}`;
    const cached = clonedRoots.get(key);
    if (cached) return cached;
    const path = `/tmp/pitchbox-extract-${run.id}-${source.id}`;
    await rm(path, { recursive: true, force: true });
    await shallowClone(value, path);
    clonedRoots.set(key, path);
    return path;
  }

  if (!isAbsolute(value)) throw new Error(`${source.kind} path must be absolute`);
  const s = await stat(value).catch(() => null);
  if (!s || !s.isDirectory())
    throw new Error(`${source.kind} ${value} is not a readable directory`);
  return value;
}

/**
 * The tree source a `files`/`read` call is about. With one tree source on
 * the project, `sourceId` is optional and that source is it; with several,
 * an omitted `sourceId` is an error naming the candidates rather than a
 * silent pick, since reading the wrong repository would produce a
 * confidently wrong description.
 */
async function resolveTreeSource(
  run: typeof schema.runs.$inferSelect,
  sourceId?: number,
): Promise<ProjectSourceRow> {
  const { sources } = await loadRunContext(run);
  const trees = sources.filter(isTreeSource);
  if (trees.length === 0) {
    throw new Error(
      'this project has no folder, repository or upload source to read as a file tree - use project_extract_sources for what its other sources fetched',
    );
  }
  if (sourceId === undefined) {
    if (trees.length === 1) return trees[0];
    const ids = trees.map((s) => `${s.id} (${s.kind})`).join(', ');
    throw new Error(`this project has several file-tree sources, pass sourceId: ${ids}`);
  }
  const match = trees.find((s) => s.id === sourceId);
  if (!match) throw new Error(`source ${sourceId} is not a file-tree source of this run's project`);
  return match;
}

// Core project-extraction / insights logic, extracted so both the CLI and the
// Pitchbox MCP server share it. Returns data (or throws); never touches exit.

export async function projectExtractStart(runId: number) {
  const db = getDb();
  const run = await loadExtractionRun(runId);
  const { project, sources } = await loadRunContext(run);

  const scenarios = SCENARIO_META.map((s) => ({
    slug: s.slug,
    label: s.label,
    description: s.description,
  }));
  const existingCampaigns = await loadExistingCampaigns(db, project.id);

  return {
    runId,
    projectId: project.id,
    scaffoldTemplate: DESCRIPTION_SCAFFOLD,
    currentDescription: project.description ?? '',
    scenarios,
    existingCampaigns,
    // The set, without its content: one line per source so the agent knows
    // what it is about to read and can say in the description where a claim
    // came from. The content itself arrives from `project_extract_sources`
    // (cached reads) and `project_extract_files`/`_read` (trees), which
    // keeps this first call small even on a project with a 40k-character
    // website crawl.
    sources: sources.map((source) => {
      const view = viewProjectSourceForAgent(source);
      return {
        id: view.id,
        kind: view.kind,
        label: view.label,
        readsAsTree: view.readsAsTree,
        fetchedAt: view.fetchedAt,
        fetchError: view.fetchError,
        hasContent: view.content !== null,
      };
    }),
  };
}

/**
 * Every non-tree source's cached read, as text (#434). This is what grounds
 * the description in a website, a Mastodon account, an HN profile or a
 * LinkedIn capture: the fetchers already flattened each one into
 * `project_sources.output`, and `viewProjectSourceForAgent` renders that
 * jsonb into prose the agent can quote. A source nothing has filled yet
 * comes back with `content: null` and whatever `fetchError` explains it,
 * rather than being hidden - the agent is told to write around a gap, not
 * to invent over it.
 */
export async function projectExtractSources(runId: number) {
  const run = await loadExtractionRun(runId);
  const { sources } = await loadRunContext(run);
  return {
    runId: run.id,
    maxCharsPerSource: SOURCE_CONTENT_MAX_CHARS,
    sources: sources.map(viewProjectSourceForAgent),
  };
}

/**
 * List one file-tree source's files, client-side (#220). The agent runs on
 * the cloud runner and has no access to this filesystem, so it navigates
 * the source through this tool and `projectExtractReadFile` instead of its
 * own Read/Bash. Paths come back relative to that source's root - the agent
 * never needs, and never gets, an absolute path on the client. `sourceId`
 * may be omitted only when the project has exactly one file-tree source;
 * with several, omitting it is an error rather than a silent pick.
 */
export async function projectExtractListFiles(runId: number, sourceId?: number) {
  const run = await loadExtractionRun(runId);
  const source = await resolveTreeSource(run, sourceId);
  const root = await realpath(await resolveTreeSourcePath(run, source));

  const files: Array<{ path: string; bytes: number }> = [];
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (truncated) return;
      // Never follow a symlink out of the tree: listing what it points at
      // would leak paths this run was never pointed at.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS[entry.name]) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const s = await stat(full).catch(() => null);
      files.push({ path: relative(root, full), bytes: s?.size ?? 0 });
    }
  };
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    runId: run.id,
    sourceId: source.id,
    kind: source.kind,
    fileCount: files.length,
    truncated,
    maxBytesPerRead: MAX_READ_BYTES,
    files,
  };
}

/**
 * Read one file from one of the run's file-tree sources, client-side
 * (#220). `path` is relative to that source's root; anything resolving
 * outside it - `..`, an absolute path, a symlink pointing away - is refused
 * rather than clamped, so a playbook (or a prompt-injected agent) cannot
 * walk the client's disk. `sourceId` may be omitted only when the project
 * has exactly one file-tree source.
 */
export async function projectExtractReadFile(runId: number, path: string, sourceId?: number) {
  const run = await loadExtractionRun(runId);
  const source = await resolveTreeSource(run, sourceId);
  const root = await realpath(await resolveTreeSourcePath(run, source));

  if (isAbsolute(path)) throw new Error('path must be relative to the source root');
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('path escapes the source root');
  }
  const real = await realpath(target).catch(() => null);
  if (!real) throw new Error(`${path} not found`);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error('path escapes the source root');
  }
  const s = await stat(real);
  if (!s.isFile()) throw new Error(`${path} is not a file`);

  const buf = await readFile(real);
  const slice = buf.subarray(0, MAX_READ_BYTES);
  return {
    runId: run.id,
    sourceId: source.id,
    path: relative(root, real),
    bytes: s.size,
    truncated: s.size > MAX_READ_BYTES,
    content: slice.toString('utf8'),
  };
}

export async function projectExtractFinish(
  runId: number,
  description: string,
  rawRecommendations: unknown[] = [],
) {
  if (!Number.isInteger(runId)) throw new Error('invalid run id');
  if (!description || !description.trim()) throw new Error('description is empty');

  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.kind !== 'project_extraction')
    throw new Error(`run ${runId} is not a project_extraction run`);
  if (!run.projectId) throw new Error(`run ${runId} has no project_id`);

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

  // Best-effort cleanup of the clone directories this run materialised. An
  // `upload` source's directory is deliberately left in place: it is the
  // content of a source row that outlives this run, so deleting it would
  // empty the source rather than free a cache. Keyed by run and source so a
  // concurrent run on another project never removes a tree in use.
  const { sources } = await loadRunContext(run);
  for (const source of sources) {
    if (source.kind !== 'git') continue;
    const path = `/tmp/pitchbox-extract-${runId}-${source.id}`;
    await rm(path, { recursive: true, force: true }).catch(() => {});
    clonedRoots.delete(`${runId}:${source.id}`);
  }

  return {
    runId,
    projectId: run.projectId,
    bytes: description.length,
    recommendations: capped.length,
  };
}

export async function projectInsightsContext(projectId: number) {
  if (!Number.isInteger(projectId)) throw new Error('invalid project id');
  const db = getDb();
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!project) throw new Error(`project ${projectId} not found`);

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

  return {
    projectId,
    projectName: project.name,
    draftCount: drafts.length,
    replyCount: messages.filter((m) => !m.isFromUs).length,
    drafts,
    messages,
  };
}

/**
 * Persist the insights summary and, when the call carries the run it belongs
 * to, close that run in the same transaction. Every other playbook's finish
 * tool does the same, which is what lets the dispatcher tell a run that saved
 * something from one that just ended its turn (#221). The runId stays optional
 * because the CLI can be pointed at a project with no run behind it.
 */
export async function projectInsights(
  projectId: number,
  summaryMd: string,
  evidence: unknown,
  runId?: number | null,
) {
  if (!Number.isInteger(projectId)) throw new Error('invalid project id');
  if (!summaryMd || !summaryMd.trim()) throw new Error('summaryMd missing');
  const ev = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : {};
  const db = getDb();

  let closeRunId: number | null = null;
  if (runId != null) {
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.kind !== 'project_insights')
      throw new Error(`run ${runId} is not a project_insights run`);
    if (run.projectId !== projectId)
      throw new Error(`run ${runId} belongs to project ${run.projectId}, not ${projectId}`);
    if (run.status === 'running') closeRunId = run.id;
  }

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.projectInsights)
      .values({ projectId, summaryMd, evidence: ev })
      .returning({
        id: schema.projectInsights.id,
        generatedAt: schema.projectInsights.generatedAt,
      });
    if (closeRunId != null) {
      await tx
        .update(schema.runs)
        .set({ status: 'success', finishedAt: new Date() })
        .where(eq(schema.runs.id, closeRunId));
    }
    return inserted;
  });

  return { id: row.id, projectId, generatedAt: row.generatedAt, runId: closeRunId };
}

export function registerProjectCommands(program: Command) {
  program
    .command('project:extract:start')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      try {
        ok(await projectExtractStart(Number(opts.run)));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('project:extract:sources')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      try {
        ok(await projectExtractSources(Number(opts.run)));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('project:extract:files')
    .requiredOption('--run <id>', 'run id')
    .option('--source <id>', 'project source id (required when the project has several trees)')
    .action(async (opts: { run: string; source?: string }) => {
      try {
        ok(
          await projectExtractListFiles(
            Number(opts.run),
            opts.source === undefined ? undefined : Number(opts.source),
          ),
        );
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('project:extract:read')
    .requiredOption('--run <id>', 'run id')
    .requiredOption('--path <path>', 'path relative to the source root')
    .option('--source <id>', 'project source id (required when the project has several trees)')
    .action(async (opts: { run: string; path: string; source?: string }) => {
      try {
        ok(
          await projectExtractReadFile(
            Number(opts.run),
            opts.path,
            opts.source === undefined ? undefined : Number(opts.source),
          ),
        );
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('project:extract:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
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

      try {
        ok(await projectExtractFinish(Number(opts.run), description, rawRecommendations));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('project:insights:context')
    .requiredOption('--project <id>', 'project id')
    .action(async (opts: { project: string }) => {
      try {
        ok(await projectInsightsContext(Number(opts.project)));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('project:insights')
    .requiredOption('--project <id>', 'project id')
    .option('--run <id>', 'run id to close (defaults to PITCHBOX_RUN_ID)')
    .action(async (opts: { project: string; run?: string }) => {
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
      const runId = opts.run ?? process.env.PITCHBOX_RUN_ID;
      try {
        ok(
          await projectInsights(
            Number(opts.project),
            summaryMd,
            payload.evidence,
            runId ? Number(runId) : null,
          ),
        );
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
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
