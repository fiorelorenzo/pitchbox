import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkBlocklist, checkContactHistory, getStagingCandidates } from '../commands/utility.js';

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

  return server;
}
