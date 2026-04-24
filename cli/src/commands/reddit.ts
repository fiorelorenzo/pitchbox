import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { runScout } from '@pitchbox/shared/platforms/reddit';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

export function registerRedditCommands(program: Command) {
  program
    .command('reddit:scout')
    .requiredOption('--run <id>', 'run id')
    .option('--verbose', 'verbose logging')
    .action(async (opts: { run: string; verbose?: boolean }) => {
      const runId = Number(opts.run);
      const db = getDb();
      const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run) return fail(`run ${runId} not found`);
      const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, run.campaignId));

      const profile = (campaign.config ?? {}) as {
        subreddits: string[];
        queries?: string[];
        perSubredditLimit?: number;
        includeHotBrowse?: boolean;
      };
      if (!profile.subreddits?.length) return fail('campaign config has no subreddits');

      const blocks = await db
        .select()
        .from(schema.blocklist)
        .where(eq(schema.blocklist.platformId, campaign.platformId));
      const blockedHandles = new Set(blocks.filter((b) => b.kind === 'user').map((b) => b.value));
      const contacted = await db
        .select({ target: schema.contactHistory.targetUser })
        .from(schema.contactHistory)
        .where(eq(schema.contactHistory.platformId, campaign.platformId));
      const contactedHandles = new Set(contacted.map((c) => c.target));

      const candidates = await runScout({
        profile,
        contactedHandles,
        blockedHandles,
        verbose: opts.verbose,
      });

      if (candidates.length > 0) {
        await db
          .insert(schema.stagingScoutCandidates)
          .values(candidates.map((c) => ({ runId, raw: c as unknown as Record<string, unknown> })));
      }

      ok({ runId, candidatesFetched: candidates.length });
    });
}
