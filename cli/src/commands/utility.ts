import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import type { Db } from '@pitchbox/shared/db';
import { and, eq } from 'drizzle-orm';
import { isBlocklisted } from '@pitchbox/shared/blocklist';
import { getProjectOrgId } from '@pitchbox/shared/orgs';
import { ok, fail } from '../lib/output.js';

async function platformIdBySlug(slug: string): Promise<number | null> {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p?.id ?? null;
}

// Resolves the org to scope a contact_history read to: the given project's
// org when a project id is supplied, otherwise the 'default' org seeded by
// seed-core. Mirrors web/src/lib/server/auth.ts's resolveOrgId fallback, so a
// single-tenant self-host install (no --project, no multi-org) behaves
// exactly as it did before this read was org-scoped.
async function resolveOrgId(db: Db, projectId: number | null): Promise<number | null> {
  if (projectId != null) return getProjectOrgId(db, projectId);
  const [row] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'))
    .limit(1);
  return row?.id ?? null;
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

// `projectId` scopes the contact-history read to that project's org (see
// `resolveOrgId`); omit it and the default org is used, never every tenant's
// history - a caller must opt into the default fallback, not fall through to
// a global scan.
export async function checkContactHistory(
  platformSlug: string,
  target: string,
  projectId?: number | null,
): Promise<{ contacted: boolean; lastContactedAt: Date | null }> {
  const pid = await platformIdBySlug(platformSlug);
  if (!pid) throw new Error(`platform ${platformSlug} not found`);
  const db = getDb();
  const orgId = await resolveOrgId(db, projectId ?? null);
  if (orgId == null) {
    throw new Error('no organization found: pass --project or seed the default organization');
  }
  const [row] = await db
    .select()
    .from(schema.contactHistory)
    .where(
      and(
        eq(schema.contactHistory.organizationId, orgId),
        eq(schema.contactHistory.platformId, pid),
        eq(schema.contactHistory.targetUser, target),
      ),
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
    .option(
      '--project <id>',
      "project id to scope the read to that project's organization; omitted falls back to the default organization (self-host), never every organization's history",
    )
    .action(async (opts: { platform: string; target: string; project?: string }) => {
      try {
        const projectId = opts.project ? Number(opts.project) : null;
        ok(await checkContactHistory(opts.platform, opts.target, projectId));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
