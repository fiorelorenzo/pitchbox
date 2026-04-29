import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { DESCRIPTION_SCAFFOLD } from '@pitchbox/shared/project-extraction';
import { eq } from 'drizzle-orm';
import { stat, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ok, fail } from '../lib/output.js';
import { shallowClone } from '../lib/git-clone.js';

type Source = { kind: 'folder'; value: string } | { kind: 'git'; value: string };

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
      } else {
        return fail(`unsupported source kind: ${(source as { kind: string }).kind}`);
      }

      ok({
        runId,
        projectId: project.id,
        sourcePath,
        scaffoldTemplate: DESCRIPTION_SCAFFOLD,
        currentDescription: project.description ?? '',
      });
    });

  program
    .command('project:extract:finish')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const runId = Number(opts.run);
      if (!Number.isInteger(runId)) return fail('invalid run id');
      const md = await readStdin();
      if (!md || !md.trim()) return fail('empty markdown on stdin');
      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      if (run.kind !== 'project_extraction')
        return fail(`run ${runId} is not a project_extraction run`);
      if (!run.projectId) return fail(`run ${runId} has no project_id`);

      await db.transaction(async (tx) => {
        await tx
          .update(schema.projects)
          .set({ description: md, updatedAt: new Date() })
          .where(eq(schema.projects.id, run.projectId!));
        await tx
          .update(schema.runs)
          .set({ status: 'success', finishedAt: new Date() })
          .where(eq(schema.runs.id, runId));
      });

      // Best-effort cleanup of the temp git clone, if any.
      const source = (run.params as { source?: { kind: string } }).source;
      if (source?.kind === 'git') {
        await rm(`/tmp/pitchbox-extract-${runId}`, { recursive: true, force: true }).catch(
          () => {},
        );
      }

      ok({ runId, projectId: run.projectId, bytes: md.length });
    });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
