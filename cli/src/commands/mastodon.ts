import { Command } from 'commander';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  runScout,
  clientFromMastodonAccount,
  type MastodonClient,
} from '@pitchbox/shared/platforms/mastodon';
import {
  evaluateDraftSend,
  mapMastodonSendParams,
  describeBlockedSend,
  type DraftLike,
} from '@pitchbox/shared/draft-send';
import { and, desc, eq } from 'drizzle-orm';
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
 * Resolve the MastodonClient to use for a campaign: the campaign's project's
 * active Mastodon account (default-first, mirroring how run:start ranks
 * accounts for the agent). Replaces the MASTODON_INSTANCE_URL /
 * MASTODON_ACCESS_TOKEN env-var stopgap now that accounts carry their own
 * instanceUrl + encrypted access token (MAS-1).
 */
async function resolveCampaignMastodonClient(
  db: ReturnType<typeof getDb>,
  projectId: number,
  platformId: number,
): Promise<MastodonClient> {
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.projectId, projectId),
        eq(schema.accounts.platformId, platformId),
        eq(schema.accounts.active, true),
      ),
    )
    .orderBy(desc(schema.accounts.isDefault));
  if (!account) {
    throw new Error('no active Mastodon account connected for this project');
  }
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY must be set');
  return clientFromMastodonAccount(account, encryptionKey);
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

  const client = await resolveCampaignMastodonClient(db, campaign.projectId, campaign.platformId);
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

export type MastodonPostKind = 'dm' | 'comment' | 'post';

export interface MastodonPostInput {
  kind: MastodonPostKind;
  status: string;
  /** Required for kind "dm" - the target's fully qualified handle to mention. */
  targetHandle?: string;
  /** Required for kind "comment" - the status id being replied to. */
  inReplyToId?: string;
}

export interface MastodonPostResult {
  runId: number;
  draftId: number;
  platformPostId: string;
  url: string | null;
}

// Maps the mcp__pitchbox__mastodon_post tool's kind vocabulary (dm/comment/post,
// matching the design doc's scenario mapping) onto the drafts.kind enum, mirroring
// how reddit-commenter/mastodon-commenter drafts use "post_comment" for a reply
// to someone else's status.
const POST_KIND_TO_DRAFT_KIND: Record<MastodonPostKind, string> = {
  dm: 'dm',
  comment: 'post_comment',
  post: 'post',
};

/**
 * Posts a Mastodon status directly via the API and records it as an
 * already-`sent` draft (MAS-5 auto-post). Only usable on a campaign with
 * `autoPost` enabled - campaigns without it must go through `drafts_create`
 * for manual review instead. Guarded by `evaluateDraftSend` (blocklist +
 * quota) exactly like the manual send path; nothing is posted when it fails.
 */
export async function postRun(
  runId: number,
  input: MastodonPostInput,
): Promise<MastodonPostResult> {
  if (input.kind === 'dm' && !input.targetHandle) {
    throw new Error('targetHandle is required for kind "dm"');
  }
  if (input.kind === 'comment' && !input.inReplyToId) {
    throw new Error('inReplyToId is required for kind "comment"');
  }

  const db = getDb();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.campaignId == null) throw new Error(`run ${runId} has no campaign`);
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, run.campaignId));
  if (!campaign) throw new Error(`campaign ${run.campaignId} not found`);
  if (!campaign.autoPost) {
    throw new Error(
      `campaign ${campaign.id} does not have auto_post enabled; use drafts_create for manual review instead`,
    );
  }

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.projectId, campaign.projectId),
        eq(schema.accounts.platformId, campaign.platformId),
        eq(schema.accounts.active, true),
      ),
    )
    .orderBy(desc(schema.accounts.isDefault));
  if (!account) throw new Error('no active Mastodon account connected for this project');

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY must be set');
  const client = clientFromMastodonAccount(account, encryptionKey);

  const draftKind = POST_KIND_TO_DRAFT_KIND[input.kind];
  const targetUser = input.targetHandle ?? null;
  const draftLike: DraftLike = {
    platformId: campaign.platformId,
    projectId: campaign.projectId,
    accountId: account.id,
    targetUser,
    kind: draftKind,
    title: null,
    body: input.status,
    metadata: {},
    scheduledSendAfter: null,
    draftingRunId: null,
  };

  const now = new Date();
  const evald = await evaluateDraftSend(db, draftLike, now);
  if (evald.kind !== 'ok') {
    throw new Error(describeBlockedSend(evald));
  }

  const params = mapMastodonSendParams({
    kind: draftKind,
    body: input.status,
    targetUser,
    platformCommentId: input.inReplyToId ?? null,
  });
  const status = await client.postStatus(params);

  const [inserted] = await db
    .insert(schema.drafts)
    .values({
      runId,
      projectId: campaign.projectId,
      platformId: campaign.platformId,
      accountId: account.id,
      kind: draftKind,
      state: 'sent',
      targetUser,
      title: null,
      body: input.status,
      sourceRef: {},
      metadata: {},
      reviewedAt: now,
      sentAt: now,
      sentContent: params.status,
      platformCommentId: input.inReplyToId ?? null,
      platformPostId: status.id,
    })
    .returning({ id: schema.drafts.id });

  await db.insert(schema.draftEvents).values({
    draftId: inserted.id,
    event: 'sent',
    actor: 'agent',
    details: evald.quotaEventDetails ?? {},
  });

  if (targetUser) {
    await db.insert(schema.contactHistory).values({
      platformId: campaign.platformId,
      accountHandle: account.handle,
      targetUser,
      lastContactedAt: now,
      draftId: inserted.id,
    });
  }

  return { runId, draftId: inserted.id, platformPostId: status.id, url: status.url ?? null };
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

  program
    .command('mastodon:post')
    .requiredOption('--run <id>', 'run id')
    .requiredOption('--kind <kind>', 'dm | comment | post')
    .requiredOption('--status <text>', 'the status text to post')
    .option('--target-handle <handle>', 'target handle to mention (required for kind=dm)')
    .option('--in-reply-to <id>', 'status id being replied to (required for kind=comment)')
    .action(
      async (opts: {
        run: string;
        kind: string;
        status: string;
        targetHandle?: string;
        inReplyTo?: string;
      }) => {
        try {
          ok(
            await postRun(Number(opts.run), {
              kind: opts.kind as MastodonPostKind,
              status: opts.status,
              targetHandle: opts.targetHandle,
              inReplyToId: opts.inReplyTo,
            }),
          );
        } catch (err) {
          fail(String(err instanceof Error ? err.message : err));
        }
      },
    );
}
