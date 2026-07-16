import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  runScout,
  loadEnv,
  acquireBrowser,
  closeBrowser,
  browserBrowseSubreddit,
  browserGetSubredditAbout,
  browserGetSubredditRules,
} from '@pitchbox/shared/platforms/reddit';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

// Fetch Reddit candidates for a run and stage them. Extracted from the commander
// action so both the CLI and the Pitchbox MCP server share it. Hits the public
// Reddit API via `runScout`; returns data or throws (never exits the process).
export async function scoutRun(
  runId: number,
  verbose?: boolean,
): Promise<{ runId: number; candidatesFetched: number }> {
  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.campaignId == null) throw new Error(`run ${runId} has no campaign`);
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, run.campaignId));

  const profile = (campaign.config ?? {}) as {
    targetSubreddits: string[];
    topicKeywords?: string[];
    perSubredditLimit?: number;
    includeHotBrowse?: boolean;
  };
  if (!profile.targetSubreddits?.length) throw new Error('campaign config has no targetSubreddits');

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

  const candidates = await runScout({ profile, contactedHandles, blockedHandles, verbose });

  if (candidates.length > 0) {
    await db
      .insert(schema.stagingScoutCandidates)
      .values(candidates.map((c) => ({ runId, raw: c as unknown as Record<string, unknown> })));
  }

  return { runId, candidatesFetched: candidates.length };
}

// Snapshot a subreddit for the poster playbook: recent top posts of the week
// plus about + rules. Extracted so the CLI and the MCP server share it. Hits
// the public Reddit API (browser); returns data or throws.
//
// This tool runs on the same long-lived local MCP process as reddit:scout
// (runScout), which shares the process-wide browser/context singletons in
// shared/src/platforms/reddit/client.ts. Bracket the browser use with
// acquireBrowser()/closeBrowser() - mirroring runScout - so a concurrent
// scout_run and subreddit_snapshot don't race each other's teardown.
export async function snapshotSubreddit(subreddit: string) {
  if (!subreddit || !subreddit.trim()) throw new Error('subreddit is required');
  const env = loadEnv();
  acquireBrowser();
  try {
    const [posts, about, rules] = await Promise.all([
      browserBrowseSubreddit(env, { subreddit, sort: 'top', timeframe: 'week', limit: 25 }),
      browserGetSubredditAbout(env, subreddit).catch(() => null),
      browserGetSubredditRules(env, subreddit).catch(
        () => [] as Awaited<ReturnType<typeof browserGetSubredditRules>>,
      ),
    ]);
    return {
      subreddit,
      about,
      rules,
      posts: posts.map((p) => ({
        title: p.title,
        selftext: (p.selftext ?? '').slice(0, 500),
        permalink: p.permalink,
        score: p.score,
        numComments: p.numComments,
        author: p.author,
        createdUtc: p.createdUtc,
      })),
    };
  } finally {
    await closeBrowser();
  }
}

export function registerRedditCommands(program: Command) {
  program
    .command('reddit:subreddit-snapshot')
    .requiredOption('--subreddit <name>', 'subreddit name (without r/)')
    .action(async (opts: { subreddit: string }) => {
      try {
        ok(await snapshotSubreddit(opts.subreddit));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  program
    .command('reddit:scout')
    .requiredOption('--run <id>', 'run id')
    .option('--verbose', 'verbose logging')
    .action(async (opts: { run: string; verbose?: boolean }) => {
      try {
        ok(await scoutRun(Number(opts.run), opts.verbose));
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });
}
