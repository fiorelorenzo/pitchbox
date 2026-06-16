import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkBlocklist, checkContactHistory, getStagingCandidates } from '../commands/utility.js';
import { startRun, finishRun } from '../commands/run.js';
import { createDrafts, Payload } from '../commands/drafts.js';
import { scoutRun } from '../commands/reddit.js';

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

/** Read a positive integer from the environment, or null if unset/invalid. */
function envInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function createPitchboxMcpServer(): McpServer {
  const server = new McpServer({ name: 'pitchbox', version: '0.4.0' });

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
      const cid = campaignId ?? envInt('PITCHBOX_CAMPAIGN_ID');
      if (cid == null) return errorResult('campaignId required (or set PITCHBOX_CAMPAIGN_ID)');
      try {
        return jsonResult(await startRun(cid, envInt('PITCHBOX_RUN_ID')));
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
      const rid = runId ?? envInt('PITCHBOX_RUN_ID');
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
      const rid = runId ?? envInt('PITCHBOX_RUN_ID');
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        return jsonResult(await createDrafts(rid, drafts));
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
      const rid = runId ?? envInt('PITCHBOX_RUN_ID');
      if (rid == null) return errorResult('runId required (or set PITCHBOX_RUN_ID)');
      try {
        return jsonResult(await finishRun(rid, status, { error, tokens }));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
    },
  );

  return server;
}
