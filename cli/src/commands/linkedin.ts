import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import type { Db } from '@pitchbox/shared/db';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { isBlocklisted } from '@pitchbox/shared/blocklist';
import {
  checkContactDedup,
  parseDedupPolicy,
  DEFAULT_DEDUP_POLICY,
} from '@pitchbox/shared/contact-dedup';
import { getRunOrgId, getRunProjectId } from '@pitchbox/shared/orgs';
import { ok, fail } from '../lib/output.js';

// Unlike reddit_scout/mastodon_scout/hn_search, linkedin_candidates fetches
// nothing itself: LinkedIn has no discovery API, so the only candidates that
// exist are the ones the browser already wrote to `observed_targets` while a
// human scrolled their own feed (see docs/linkedin-integration-design.md,
// "Consumption"). This drains that buffer into `staging_scout_candidates`
// for the run, exactly the shape `staging_candidates` already reads, so the
// rest of the playbook (score fit, draft, run_finish) is unchanged.

/** Rows claimed but older than this are dropped as stale. Mirrors Mastodon's maxAgeHours default. */
const DEFAULT_MAX_AGE_HOURS = 72;
/** No minimum wait by default: a row is eligible the moment it lands in the buffer. */
const DEFAULT_MIN_AGE_MINUTES = 0;
/** Default batch size for one drain call. */
const DEFAULT_LIMIT = 20;
/** Upper bound on how many rows one call can claim, matching the ingest side's own per-batch cap. */
const MAX_LIMIT = 200;

export interface LinkedinCandidatesInput {
  runId: number;
  /** Max observed_targets rows to claim in this call. Default 20, capped at 200. */
  limit?: number;
  /** Only claim rows observed at least this many minutes ago. Default 0. */
  minAgeMinutes?: number;
  /** Drop rows older than this as stale. Default 72. */
  maxAgeHours?: number;
}

export interface LinkedinCandidatesResult {
  runId: number;
  candidatesFetched: number;
}

async function linkedinPlatformId(db: Db): Promise<number> {
  const [row] = await db
    .select({ id: schema.platforms.id })
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  if (!row) throw new Error('linkedin platform not found');
  return row.id;
}

/**
 * Drains unconsumed `observed_targets` for the run's project into
 * `staging_scout_candidates` for the run. Extracted so both the CLI and the
 * Pitchbox MCP server share it (mirrors reddit.ts/mastodon.ts's scoutRun).
 *
 * Claiming (marking `consumed_by_run_id`) and staging happen in one
 * transaction: the claim itself is a single `UPDATE ... WHERE id IN (SELECT
 * ... FOR UPDATE SKIP LOCKED)` so two concurrent calls draining the same
 * project's buffer never claim the same row - each transaction's inner
 * SELECT skips rows already locked by the other rather than blocking on
 * them, so both proceed concurrently over disjoint rows.
 *
 * Blocklist and contact-dedup are applied server-side, per candidate, the
 * same helpers `drafts:create` uses (`isBlocklisted`, `checkContactDedup`)
 * rather than trusting the playbook to re-check - a blocklisted or
 * recently-contacted author's post is claimed (so it is never re-offered on
 * a later drain) but not staged, so it never reaches the agent. Unlike
 * `drafts:create`'s dedup policy, there is no draft yet to attach a "warn"
 * to here, so any contact inside the window is unconditionally excluded
 * rather than staged-with-a-warning.
 */
export async function linkedinCandidatesRun(
  input: LinkedinCandidatesInput,
): Promise<LinkedinCandidatesResult> {
  const { runId } = input;
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const minAgeMinutes = Math.max(0, input.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES);
  const maxAgeHours = Math.max(0, input.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS);

  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);

  // Resolves via runs.project_id directly or runs.campaign_id -> campaigns.project_id
  // (the same join runBelongsToOrg/checkOwnership use), so this works for a
  // campaign-triggered LinkedIn run the same way the MCP boundary already does.
  const projectId = await getRunProjectId(db, runId);
  if (projectId == null) throw new Error(`run ${runId} has no project`);
  const orgId = await getRunOrgId(db, runId);
  if (orgId == null) throw new Error(`run ${runId} has no organization`);

  const platformId = await linkedinPlatformId(db);

  const [policyRow] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'dedup_policy'));
  const dedupPolicy = policyRow ? parseDedupPolicy(policyRow.value) : { ...DEFAULT_DEDUP_POLICY };

  const now = Date.now();
  // Must be observed at least minAgeMinutes ago.
  const notObservedAfter = new Date(now - minAgeMinutes * 60_000);
  // Must not be older than maxAgeHours.
  const notObservedBefore = new Date(now - maxAgeHours * 60 * 60_000);

  const staged = await db.transaction(async (tx) => {
    const claimIds = tx
      .select({ id: schema.observedTargets.id })
      .from(schema.observedTargets)
      .where(
        and(
          eq(schema.observedTargets.organizationId, orgId),
          eq(schema.observedTargets.projectId, projectId),
          eq(schema.observedTargets.platformId, platformId),
          isNull(schema.observedTargets.consumedByRunId),
          lte(schema.observedTargets.observedAt, notObservedAfter),
          gte(schema.observedTargets.observedAt, notObservedBefore),
        ),
      )
      .orderBy(asc(schema.observedTargets.observedAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    const claimed = await tx
      .update(schema.observedTargets)
      .set({ consumedByRunId: runId })
      .where(inArray(schema.observedTargets.id, claimIds))
      .returning();
    if (claimed.length === 0) return [];

    // UPDATE ... RETURNING has no ordering guarantee; restore oldest-first.
    claimed.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

    const survivors: (typeof schema.stagingScoutCandidates.$inferInsert)[] = [];
    for (const row of claimed) {
      if (row.authorHandle) {
        const block = await isBlocklisted(tx as unknown as Db, {
          platformId,
          projectId,
          targetUser: row.authorHandle,
        });
        if (block.blocked) continue;

        const dedup = await checkContactDedup(tx as unknown as Db, {
          platformId,
          targetUser: row.authorHandle,
          windowDays: dedupPolicy.windowDays,
          organizationId: orgId,
        });
        if (dedup.withinWindow) continue;
      }
      survivors.push({
        runId,
        raw: {
          author: { handle: row.authorHandle, name: row.authorName },
          post: {
            externalId: row.externalId,
            url: row.url,
            text: row.text,
            observedAt: row.observedAt.toISOString(),
          },
        },
      });
    }

    if (survivors.length > 0) {
      await tx.insert(schema.stagingScoutCandidates).values(survivors);
    }
    return survivors;
  });

  return { runId, candidatesFetched: staged.length };
}

export function registerLinkedinCommands(program: Command) {
  program
    .command('linkedin:candidates')
    .requiredOption('--run <id>', 'run id')
    .option('--limit <n>', 'max observed rows to claim (default 20)')
    .option(
      '--min-age-minutes <n>',
      'only claim rows observed at least this many minutes ago (default 0)',
    )
    .option('--max-age-hours <n>', 'drop rows older than this as stale (default 72)')
    .action(
      async (opts: {
        run: string;
        limit?: string;
        minAgeMinutes?: string;
        maxAgeHours?: string;
      }) => {
        try {
          ok(
            await linkedinCandidatesRun({
              runId: Number(opts.run),
              limit: opts.limit != null ? Number(opts.limit) : undefined,
              minAgeMinutes: opts.minAgeMinutes != null ? Number(opts.minAgeMinutes) : undefined,
              maxAgeHours: opts.maxAgeHours != null ? Number(opts.maxAgeHours) : undefined,
            }),
          );
        } catch (err) {
          fail(String(err instanceof Error ? err.message : err));
        }
      },
    );
}
