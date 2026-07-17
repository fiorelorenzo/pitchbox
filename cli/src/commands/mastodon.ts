import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import { runScout, MastodonClient } from '@pitchbox/shared/platforms/mastodon';
import { eq } from 'drizzle-orm';
import { ok, fail } from '../lib/output.js';

// Shape of a Mastodon scout campaign's `config`, mirroring reddit.ts's
// profile shape: hashtag timelines stand in for the subreddit list since
// Mastodon has no reliable full-text search.
export interface MastodonScoutProfile {
  targetHashtags: string[];
  keywords?: string[];
  perTagLimit?: number;
  maxAgeHours?: number;
  sinceId?: string;
}

/**
 * Build a MastodonClient from the environment. This is a stopgap until the
 * account model lands (instanceUrl + encrypted access token per account,
 * MAS-1): once it does, scoutRun should read credentials from the campaign's
 * account row instead of the process environment.
 */
function clientFromEnv(): MastodonClient {
  const instanceUrl = process.env.MASTODON_INSTANCE_URL;
  const accessToken = process.env.MASTODON_ACCESS_TOKEN;
  if (!instanceUrl || !accessToken) {
    throw new Error(
      'MASTODON_INSTANCE_URL and MASTODON_ACCESS_TOKEN must be set (per-account Mastodon credentials are not wired yet)',
    );
  }
  return new MastodonClient({ instanceUrl, accessToken });
}

// Fetch Mastodon candidates for a run and stage them. Extracted from the
// commander action so both the CLI and the MCP server share it, mirroring
// reddit.ts's scoutRun. Hits the Mastodon REST API via `runScout`; returns
// data or throws (never exits the process).
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

  const profile = (campaign.config ?? {}) as MastodonScoutProfile;
  if (!profile.targetHashtags?.length) throw new Error('campaign config has no targetHashtags');

  const blocks = await db
    .select()
    .from(schema.blocklist)
    .where(eq(schema.blocklist.platformId, campaign.platformId));
  const blockedHandles = new Set(blocks.filter((b) => b.kind === 'user').map((b) => b.value));
  const blockedKeywords = new Set(blocks.filter((b) => b.kind === 'keyword').map((b) => b.value));
  const contacted = await db
    .select({ target: schema.contactHistory.targetUser })
    .from(schema.contactHistory)
    .where(eq(schema.contactHistory.platformId, campaign.platformId));
  const contactedHandles = new Set(contacted.map((c) => c.target));

  if (verbose) {
    process.stderr.write(
      `[mastodon:scout] hashtags=${profile.targetHashtags.join(',')} run=${runId}\n`,
    );
  }

  const client = clientFromEnv();
  const candidates = await runScout({
    client,
    hashtags: profile.targetHashtags,
    keywords: profile.keywords,
    perTagLimit: profile.perTagLimit,
    sinceId: profile.sinceId,
    maxAgeHours: profile.maxAgeHours,
    contactedHandles,
    blockedHandles,
    blockedKeywords,
  });

  if (candidates.length > 0) {
    await db
      .insert(schema.stagingScoutCandidates)
      .values(candidates.map((c) => ({ runId, raw: c as unknown as Record<string, unknown> })));
  }

  return { runId, candidatesFetched: candidates.length };
}

export function registerMastodonCommands(program: Command) {
  program
    .command('mastodon:scout')
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
