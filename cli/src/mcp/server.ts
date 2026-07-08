import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
  const server = new McpServer({ name: 'pitchbox', version: '0.4.0' });

  const defaultRunId = () => ctx.runId ?? posInt(process.env.PITCHBOX_RUN_ID);
  const defaultCampaignId = () => ctx.campaignId ?? posInt(process.env.PITCHBOX_CAMPAIGN_ID);
  const defaultProjectId = () =>
    ctx.projectId ?? posInt(process.env.PITCHBOX_PROJECT_ID) ?? posInt(process.env.PROJECT_ID);

  server.registerTool(
    'blocklist_check',
    {
      title: 'Check blocklist',
      description:
        'Check whether a user handle is blocklisted on a platform. Returns { blocked, reason }.',
      inputSchema: {
        platform: z.string().describe('platform slug, e.g. "reddit"'),
        user: z.string().describe('user handle to check'),
      },
    },
    async ({ platform, user }) => {
      try {
        return jsonResult(await checkBlocklist(platform, user));
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
        return jsonResult(await scoutRun(rid));
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
        return jsonResult(id != null ? await getDraftById(id) : await listDrafts(state));
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
        return jsonResult(await skillGenerateFinish(rid, profile));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  return server;
}
