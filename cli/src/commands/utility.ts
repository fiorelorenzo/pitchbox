import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { and, eq } from 'drizzle-orm';
import { isBlocklisted } from '@pitchbox/shared/blocklist';
import { ok, fail } from '../lib/output.js';

async function platformIdBySlug(slug: string): Promise<number | null> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p?.id ?? null;
}

// Core query logic, extracted from the commander actions so it can be reused by
// both the `pitchbox` CLI and the Pitchbox MCP server (see cli/src/mcp/). These
// functions return data (or throw) and never touch process exit, so they are
// safe to call in-process.

export async function getStagingCandidates(runId: number): Promise<unknown[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.stagingScoutCandidates)
    .where(eq(schema.stagingScoutCandidates.runId, runId));
  return rows.map((r) => r.raw);
}

export async function checkBlocklist(
  platformSlug: string,
  user: string,
  projectId?: number | null,
): Promise<{ blocked: boolean; reason: string | null }> {
  const pid = await platformIdBySlug(platformSlug);
  if (!pid) throw new Error(`platform ${platformSlug} not found`);
  const db = getDb();
  // Delegates to the authoritative isBlocklisted (lowercase compare +
  // global-or-project scope) so this MCP-facing check never diverges from
  // the checks enforced at draft-create and draft-send time.
  return isBlocklisted(db, { platformId: pid, projectId: projectId ?? null, targetUser: user });
}

export async function checkContactHistory(
  platformSlug: string,
  target: string,
): Promise<{ contacted: boolean; lastContactedAt: Date | null }> {
  const pid = await platformIdBySlug(platformSlug);
  if (!pid) throw new Error(`platform ${platformSlug} not found`);
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.contactHistory)
    .where(
      and(eq(schema.contactHistory.platformId, pid), eq(schema.contactHistory.targetUser, target)),
    );
  return { contacted: !!row, lastContactedAt: row?.lastContactedAt ?? null };
}

export function registerUtilityCommands(program: Command) {
  program
    .command('staging:candidates')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      ok(await getStagingCandidates(Number(opts.run)));
    });

  program
    .command('blocklist:check')
    .requiredOption('--platform <slug>')
    .requiredOption('--user <handle>')
    .option('--project <id>', 'project id, for project-scoped blocklist entries')
    .action(async (opts: { platform: string; user: string; project?: string }) => {
      try {
        const projectId = opts.project ? Number(opts.project) : null;
        ok(await checkBlocklist(opts.platform, opts.user, projectId));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('contact-history:check')
    .requiredOption('--platform <slug>')
    .requiredOption('--target <handle>')
    .action(async (opts: { platform: string; target: string }) => {
      try {
        ok(await checkContactHistory(opts.platform, opts.target));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
