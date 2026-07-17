import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '@pitchbox/shared/db';
import {
  runBelongsToOrg,
  campaignBelongsToOrg,
  projectBelongsToOrg,
  draftBelongsToOrg,
  getRunOrgId,
  getCampaignOrgId,
  getProjectOrgId,
  getRunProjectId,
  getCampaignProjectId,
} from '@pitchbox/shared/orgs';
import { checkBlocklist, checkContactHistory, getStagingCandidates } from '../commands/utility.js';
import { startRun, finishRun } from '../commands/run.js';
import {
  createDrafts,
  Payload,
  getDraftById,
  listDrafts,
  updateDraftBody,
  draftRegenStart,
  draftRegenFinish,
  replyDraftStart,
  replyDraftFinish,
} from '../commands/drafts.js';
import { scoutRun, snapshotSubreddit } from '../commands/reddit.js';
import {
  scoutRun as mastodonScoutRun,
  postRun as mastodonPostRun,
  type MastodonPostKind,
} from '../commands/mastodon.js';
import { searchHn, HN_LISTINGS } from '../commands/hn.js';
import type { HnListing } from '@pitchbox/shared/platforms/hackernews';
import {
  projectExtractStart,
  projectExtractFinish,
  projectInsightsContext,
  projectInsights,
} from '../commands/project.js';
import { skillGenerateStart, skillGenerateFinish } from '../commands/skill.js';

// The Pitchbox MCP server exposes the data-access surface that playbooks need as
// MCP tools, reusing the same query logic as the `pitchbox` CLI. It is the single
// data-access boundary for agents: local runners spawn it over stdio, and the
// cloud runner reaches it over the network relay (see docs/cloud-runner.md).
//
// This file only builds the server; the stdio entrypoint lives in ./index.ts so
// tests can attach an in-memory transport instead of spawning a process.

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Parse a positive integer from a raw string, or null if unset/invalid. */
function posInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Run/campaign/project the server is bound to. An explicit context (the cloud
 * adapter, which runs the server in-process and needs per-instance binding) wins
 * over the session env (the local runner, which spawns the server as a subprocess
 * with run-specific env).
 */
export interface PitchboxMcpContext {
  runId?: number;
  campaignId?: number;
  projectId?: number;
}

export function createPitchboxMcpServer(ctx: PitchboxMcpContext = {}): McpServer {
  const server = new McpServer({ name: 'pitchbox', version: '0.5.0' });

  const defaultRunId = () => ctx.runId ?? posInt(process.env.PITCHBOX_RUN_ID);
  const defaultCampaignId = () => ctx.campaignId ?? posInt(process.env.PITCHBOX_CAMPAIGN_ID);
  const defaultProjectId = () =>
    ctx.projectId ?? posInt(process.env.PITCHBOX_PROJECT_ID) ?? posInt(process.env.PROJECT_ID);

  // The organization this MCP session is bound to, resolved once (memoized
  // for the life of this server instance) from the session-bound run,
  // campaign, or project id - never from a tool-call argument. Every tool
  // below that accepts a run/campaign/project/draft id verifies the
  // *effective* id (the session default, or an agent-supplied override)
  // resolves to this same organization before touching the DB. This is
  // defense-in-depth: the dispatch layer that injects the session's ids
  // already validates ownership before the agent ever sees this server (see
  // docs/organization-isolation-design.md, "MCP / agent boundary"), but the
  // agent reads untrusted scraped text, so a tool-supplied id is never
  // trusted on its own.
  let sessionOrgIdPromise: Promise<number | null> | null = null;
  const sessionOrgId = (): Promise<number | null> => {
    if (!sessionOrgIdPromise) {
      sessionOrgIdPromise = (async () => {
        const db = getDb();
        const rid = defaultRunId();
        if (rid != null) return getRunOrgId(db, rid);
        const cid = defaultCampaignId();
        if (cid != null) return getCampaignOrgId(db, cid);
        const pid = defaultProjectId();
        if (pid != null) return getProjectOrgId(db, pid);
        return null;
      })();
    }
    return sessionOrgIdPromise;
  };

  // The project this MCP session is bound to, resolved the same way (used to
  // scope `drafts_get`'s list mode instead of scanning every project's
  // drafts).
  let sessionProjectIdPromise: Promise<number | null> | null = null;
  const sessionProjectId = (): Promise<number | null> => {
    if (!sessionProjectIdPromise) {
      sessionProjectIdPromise = (async () => {
        const pid = defaultProjectId();
        if (pid != null) return pid;
        const db = getDb();
        const rid = defaultRunId();
        if (rid != null) return getRunProjectId(db, rid);
        const cid = defaultCampaignId();
        if (cid != null) return getCampaignProjectId(db, cid);
        return null;
      })();
    }
    return sessionProjectIdPromise;
  };

  /**
   * Verifies that `id` (of the given kind) belongs to the session's bound
   * organization. Returns an error message (to surface as a tool error) when
   * it does not, or null when the check passes. When the session has no
   * bound organization to check against (no run/campaign/project id at all
   * is available - e.g. the server invoked with no session context), the
   * check is skipped: there is nothing to enforce against, and the
   * downstream command function still validates the id exists.
   */
  async function checkOwnership(
    kind: 'run' | 'campaign' | 'project' | 'draft',
    id: number,
  ): Promise<string | null> {
    const orgId = await sessionOrgId();
    if (orgId == null) return null;
    const db = getDb();
    const belongs = await (kind === 'run'
      ? runBelongsToOrg(db, id, orgId)
      : kind === 'campaign'
        ? campaignBelongsToOrg(db, id, orgId)
        : kind === 'project'
          ? projectBelongsToOrg(db, id, orgId)
          : draftBelongsToOrg(db, id, orgId));
    return belongs ? null : `${kind} ${id} does not belong to this session's organization`;
  }

  server.registerTool(
    'blocklist_check',
    {
      title: 'Check blocklist',
      description:
        'Check whether a user handle is blocklisted on a platform (global or project scope). Returns { blocked, reason }.',
      inputSchema: {
        platform: z.string().describe('platform slug, e.g. "reddit"'),
        user: z.string().describe('user handle to check'),
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'project id, for project-scoped blocklist entries (defaults to PITCHBOX_PROJECT_ID / PROJECT_ID)',
          ),
      },
    },
    async ({ platform, user, projectId }) => {
      try {
        const pid = projectId ?? defaultProjectId();
        if (pid != null) {
          const ownershipErr = await checkOwnership('project', pid);
          if (ownershipErr) return errorResult(ownershipErr);
        }
        return jsonResult(await checkBlocklist(platform, user, pid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'contact_history_check',
    {
      title: 'Check contact history',
      description:
        'Check whether a target handle was already contacted on a platform. Returns { contacted, lastContactedAt }.',
      inputSchema: {
        platform: z.string().describe('platform slug, e.g. "reddit"'),
        target: z.string().describe('target handle to check'),
      },
    },
    async ({ platform, target }) => {
      try {
        return jsonResult(await checkContactHistory(platform, target));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'staging_candidates',
    {
      title: 'List staged scout candidates',
      description:
        'Return the raw scout candidates staged for a run, as an array of candidate objects.',
      inputSchema: {
        run: z.number().int().positive().describe('run id'),
      },
    },
    async ({ run }) => {
      const ownershipErr = await checkOwnership('run', run);
      if (ownershipErr) return errorResult(ownershipErr);
      return jsonResult(await getStagingCandidates(run));
    },
  );

  server.registerTool(
    'run_start',
    {
      title: 'Start a campaign run',
      description:
        'Create or resume the run row and load full campaign context: config, project, platform, accounts, blocklist, recently contacted handles, and few-shot templates. Defaults to the campaign/run bound to this session.',
      inputSchema: {
        campaignId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('campaign id (defaults to PITCHBOX_CAMPAIGN_ID)'),
      },
    },
    async ({ campaignId }) => {
      const cid = campaignId ?? defaultCampaignId();
      if (cid == null) return errorResult('campaignId required (or set PITCHBOX_CAMPAIGN_ID)');
      try {
        const ownershipErr = await checkOwnership('campaign', cid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await startRun(cid, defaultRunId()));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'reddit_scout',
    {
      title: 'Fetch and stage Reddit candidates',
      description:
        'Fetch Reddit candidates for the run via the campaign profile, apply blocklist + contact-history filters, and stage them. Returns { runId, candidatesFetched }.',
      inputSchema: {
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await scoutRun(rid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'mastodon_scout',
    {
      title: 'Fetch and stage Mastodon candidates',
      description:
        'Fetch Mastodon candidates for the run via hashtag-timeline discovery on the campaign profile, apply the #nobot hard rule plus blocklist + contact-history filters, and stage them. Returns { runId, candidatesFetched }.',
      inputSchema: {
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await mastodonScoutRun(rid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'mastodon_post',
    {
      title: 'Post a Mastodon status',
      description:
        'Post a status directly via the Mastodon API and record it as an already-sent draft. Only usable when the session-bound campaign has auto_post enabled - other campaigns must use drafts_create for manual review instead. Runs the same blocklist + quota guardrails as the manual send path (evaluateDraftSend); nothing is posted when it fails. kind "dm" -> a direct-visibility status mentioning targetHandle; "comment" -> a public reply using inReplyToId; "post" -> a public top-level status. Returns { runId, draftId, platformPostId, url }.',
      inputSchema: {
        kind: z.enum(['dm', 'comment', 'post']),
        status: z.string().min(1).describe('the status text to post'),
        targetHandle: z
          .string()
          .optional()
          .describe('target handle to mention - required for kind "dm"'),
        inReplyToId: z
          .string()
          .optional()
          .describe('status id being replied to - required for kind "comment"'),
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ kind, status, targetHandle, inReplyToId, runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(
          await mastodonPostRun(rid, {
            kind: kind as MastodonPostKind,
            status,
            targetHandle,
            inReplyToId,
          }),
        );
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'drafts_create',
    {
      title: 'Create drafts',
      description:
        'Persist drafts for the run. Applies blocklist + contact-dedup filters; blocklisted or recently-contacted targets are skipped. Returns { runId, inserted, skipped, dedupSkipped }.',
      inputSchema: {
        drafts: Payload,
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ drafts, runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await createDrafts(rid, drafts));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'subreddit_snapshot',
    {
      title: 'Snapshot a subreddit',
      description:
        'Fetch a subreddit snapshot for the poster playbook: top posts of the week plus about + rules. Returns { subreddit, about, rules, posts }.',
      inputSchema: {
        subreddit: z.string().describe('subreddit name without the r/ prefix'),
      },
    },
    async ({ subreddit }) => {
      try {
        return jsonResult(await snapshotSubreddit(subreddit));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'drafts_get',
    {
      title: 'Get drafts',
      description:
        'Fetch a single draft with its thread messages when `id` is given, otherwise list drafts (optionally filtered by state).',
      inputSchema: {
        id: z.number().int().positive().optional().describe('fetch one draft with its messages'),
        state: z.string().optional().describe('filter the list by draft state'),
      },
    },
    async ({ id, state }) => {
      try {
        if (id != null) {
          const ownershipErr = await checkOwnership('draft', id);
          if (ownershipErr) return errorResult(ownershipErr);
          return jsonResult(await getDraftById(id));
        }
        // List mode: always scope to the session's bound project rather than
        // scanning every project's drafts (see checkOwnership's doc comment
        // on the MCP boundary above).
        const pid = await sessionProjectId();
        if (pid == null) {
          return errorResult(
            'drafts_get list mode requires a session-bound run, campaign, or project',
          );
        }
        return jsonResult(await listDrafts(state, pid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'drafts_update',
    {
      title: 'Update a draft body',
      description: 'Overwrite the body of an existing draft (used by the reply-drafter playbook).',
      inputSchema: {
        id: z.number().int().positive().describe('draft id'),
        body: z.string().min(1).describe('the new draft body'),
      },
    },
    async ({ id, body }) => {
      try {
        const ownershipErr = await checkOwnership('draft', id);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await updateDraftBody(id, body));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'draft_regen_start',
    {
      title: 'Start a draft regeneration',
      description:
        'Load the regeneration context: the draft body/title, its target, the reviewer hint, the platform, and the originating persona (playbook). Defaults to this session run.',
      inputSchema: {
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await draftRegenStart(rid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'draft_regen_finish',
    {
      title: 'Finish a draft regeneration',
      description:
        'Persist the rewritten draft body (and title for post drafts). Bumps the draft version, records the previous body for undo, and marks the run success. Returns { draftId, version, regenerationCount }.',
      inputSchema: {
        body: z.string().min(1).describe('the rewritten draft body'),
        title: z.string().optional().describe('new title (post drafts only)'),
        qualityScore: z.number().optional().describe('quality score 0-100 for the rewritten draft'),
        qualityReason: z.string().optional().describe('one-line reason for the score'),
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ body, title, qualityScore, qualityReason, runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await draftRegenFinish(rid, body, title, qualityScore, qualityReason));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'reply_draft_start',
    {
      title: 'Start a reply drafting',
      description:
        'Load the reply-drafting context: the placeholder reply draft, the parent outbound draft (for voice), the full conversation thread in chronological order, and the platform. Defaults to this session run.',
      inputSchema: {
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await replyDraftStart(rid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'reply_draft_finish',
    {
      title: 'Finish a reply drafting',
      description:
        'Persist the drafted reply body, clear the drafting flag, and mark the run success. Returns { draftId }.',
      inputSchema: {
        body: z.string().min(1).describe('the drafted reply body'),
        qualityScore: z.number().optional().describe('quality score 0-100 for the drafted reply'),
        qualityReason: z.string().optional().describe('one-line reason for the score'),
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ body, qualityScore, qualityReason, runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await replyDraftFinish(rid, body, qualityScore, qualityReason));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'hn_search',
    {
      title: 'Search Hacker News',
      description:
        'Fetch Hacker News stories from a listing, optionally filtered by a case-insensitive query. Returns { count, items }.',
      inputSchema: {
        listing: z.enum(HN_LISTINGS as [HnListing, ...HnListing[]]).optional(),
        query: z.string().optional().describe('case-insensitive substring match on title/text'),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ listing, query, limit }) => {
      try {
        return jsonResult(await searchHn(listing ?? 'top', query, limit ?? 30));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'run_finish',
    {
      title: 'Finish a campaign run',
      description: 'Mark the run as success or failed. Defaults to the run bound to this session.',
      inputSchema: {
        status: z.enum(['success', 'failed']),
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
        error: z.string().optional().describe('error message when status is failed'),
        tokens: z.number().int().optional(),
      },
    },
    async ({ status, runId, error, tokens }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await finishRun(rid, status, { error, tokens }));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'project_extract_start',
    {
      title: 'Start a project extraction',
      description:
        'Load the project-extraction context: projectId, sourcePath to inspect, scaffold template, current description, available scenarios, and existing campaigns. Defaults to this session run.',
      inputSchema: {
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await projectExtractStart(rid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'project_extract_finish',
    {
      title: 'Finish a project extraction',
      description:
        'Persist the generated project description and 0-10 campaign recommendations. Invalid recommendations are dropped; the description is saved when non-empty. Returns { runId, projectId, bytes, recommendations }.',
      inputSchema: {
        description: z.string().min(1).describe('the composed markdown project description'),
        recommendations: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('array of { scenarioSlug, name, objective }'),
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ description, recommendations, runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await projectExtractFinish(rid, description, recommendations ?? []));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'project_insights_context',
    {
      title: 'Load project insights context',
      description:
        'Load a project outreach history for analysis: draft count, reply count, and sampled drafts/messages. Returns the context object.',
      inputSchema: {
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('project id (defaults to PITCHBOX_PROJECT_ID / PROJECT_ID)'),
      },
    },
    async ({ projectId }) => {
      const pid = projectId ?? defaultProjectId();
      if (pid == null) return errorResult('projectId required (or set PITCHBOX_PROJECT_ID)');
      try {
        const ownershipErr = await checkOwnership('project', pid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await projectInsightsContext(pid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'project_insights',
    {
      title: 'Persist a project insights summary',
      description: 'Persist a generated insights summary (markdown + evidence) for a project.',
      inputSchema: {
        summaryMd: z.string().min(1).describe('the markdown insights summary'),
        evidence: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('cited draft/message ids etc.'),
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('project id (defaults to PITCHBOX_PROJECT_ID / PROJECT_ID)'),
      },
    },
    async ({ summaryMd, evidence, projectId }) => {
      const pid = projectId ?? defaultProjectId();
      if (pid == null) return errorResult('projectId required (or set PITCHBOX_PROJECT_ID)');
      try {
        const ownershipErr = await checkOwnership('project', pid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await projectInsights(pid, summaryMd, evidence));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'skill_generate_start',
    {
      title: 'Start a campaign skill generation',
      description:
        'Load the skill-generation context: campaignId, scenario, objective, project description, schema prompt description, and existing config. Defaults to this session run.',
      inputSchema: {
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await skillGenerateStart(rid));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  server.registerTool(
    'skill_generate_finish',
    {
      title: 'Finish a campaign skill generation',
      description:
        'Validate the generated profile against the scenario schema and write it to campaigns.config (flipping a draft campaign to active). Returns a tool error listing field paths when validation fails.',
      inputSchema: {
        profile: z
          .record(z.string(), z.unknown())
          .describe('the structured campaign profile (campaign.config)'),
        runId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('run id (defaults to PITCHBOX_RUN_ID)'),
      },
    },
    async ({ profile, runId }) => {
      const rid = runId ?? defaultRunId();
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        const ownershipErr = await checkOwnership('run', rid);
        if (ownershipErr) return errorResult(ownershipErr);
        return jsonResult(await skillGenerateFinish(rid, profile));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  return server;
}
