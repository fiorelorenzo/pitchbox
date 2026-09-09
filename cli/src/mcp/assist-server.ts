// cli/src/mcp/assist-server.ts (#567)
//
// The assist MCP server: exposes exactly the seven read-only tools declared
// in `shared/src/assist/tools.ts` to the ACP path's agent loop
// (docs/design/in-page-agent.md, section 1). A sibling of
// `cli/src/mcp/server.ts`, the campaign MCP server - deliberately not built
// on top of it or importing any of its tool registrations, because the two
// planes carry different privileges (26 tools, most of them writers, bound
// to a `runs` row, vs seven read-only tools bound to an org and a project).
// Handing the assistant `drafts_create` or `run_finish` because they happen
// to share a process would undo the isolation #520 exists for.
//
// This server's session binds to an organization and a bound project rather
// than a run, campaign or `PITCHBOX_RUN_ID`/`PITCHBOX_CAMPAIGN_ID` - there is
// no run row on this plane (`web/src/lib/server/suggest.ts` spawns no `runs`
// row for a suggestion). The observed target (the post, its thread, its
// image crop) and the operator persona are both too large and too
// structured to carry as scalar env vars the way `PITCHBOX_PROJECT_ID` does,
// so they travel as a JSON file the caller writes into the run's temp cwd
// before spawning this process (mirrors `web/src/lib/server/suggest.ts`'s
// existing `mkdtemp`/`rm` temp-dir lifecycle) - `PITCHBOX_ASSIST_CONTEXT_FILE`
// names it. This server only ever reads that file; it never writes one.

import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '@pitchbox/shared/db';
import {
  ASSIST_TOOLS,
  type AssistObservedTarget,
  type AssistToolContext,
} from '@pitchbox/shared/assist/tools';
import type { OperatorPersona } from '@pitchbox/shared/assist/context';

/**
 * Session binding for the assist MCP tools. An explicit context (the SDK
 * side, if it ever reused this server in-process) wins over the session env
 * a spawned subprocess reads, the same precedence `PitchboxMcpContext`
 * (./server.ts) follows. `boundProjectId` is optional (#523): a suggestion
 * about no particular product still runs, with `project_knowledge` simply
 * refusing every call since it has nothing to validate a project id
 * against.
 */
export interface AssistMcpContext {
  organizationId?: number;
  boundProjectId?: number;
  /** Path to the JSON context file, shaped `AssistRequestPayload` below. */
  contextFile?: string;
}

/** What the context file carries: everything server-resolved before the
 * loop starts, that a tool handler needs but cannot re-derive from
 * `organizationId`/`boundProjectId` alone. */
export interface AssistRequestPayload {
  observedTarget: AssistObservedTarget | null;
  operator: OperatorPersona | null;
}

/**
 * Builds the assist MCP server. Registers `ASSIST_TOOLS` (`shared/src/
 * assist/tools.ts`) one for one under their own names, with no extra tool
 * and no renaming - a test asserts the exposed set is exactly those seven
 * and none of the campaign server's.
 */
export function createAssistMcpServer(ctx: AssistMcpContext = {}): McpServer {
  const server = new McpServer({ name: 'pitchbox-assist', version: '0.1.0' });

  const rawOrgId = Number(process.env.PITCHBOX_ASSIST_ORG_ID);
  const organizationId =
    ctx.organizationId ?? (Number.isInteger(rawOrgId) && rawOrgId > 0 ? rawOrgId : undefined);
  const rawProjectId = Number(process.env.PITCHBOX_ASSIST_PROJECT_ID);
  const boundProjectId =
    ctx.boundProjectId ??
    (Number.isInteger(rawProjectId) && rawProjectId > 0 ? rawProjectId : undefined);
  const contextFile = ctx.contextFile ?? process.env.PITCHBOX_ASSIST_CONTEXT_FILE;

  // Read once per server instance (a fresh process per suggestion, same
  // lifetime as the campaign server's own per-run spawn) and memoized -
  // every tool call in this session reads the same observed target.
  let payloadPromise: Promise<AssistRequestPayload> | null = null;
  const loadPayload = (): Promise<AssistRequestPayload> => {
    if (!payloadPromise) {
      payloadPromise = (async () => {
        if (!contextFile) return { observedTarget: null, operator: null };
        try {
          const raw = await readFile(contextFile, 'utf8');
          const parsed = JSON.parse(raw) as Partial<AssistRequestPayload>;
          return {
            observedTarget: parsed.observedTarget ?? null,
            operator: parsed.operator ?? null,
          };
        } catch {
          // A missing or unreadable context file degrades to "nothing was
          // captured", the same explicit-nothing every tool already
          // handles for a real empty observation - never a thrown error
          // that would fail every tool call in the session.
          return { observedTarget: null, operator: null };
        }
      })();
    }
    return payloadPromise;
  };

  for (const tool of ASSIST_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.name, description: tool.description, inputSchema: tool.schema },
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        if (organizationId == null) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  'this assist MCP session has no bound organization - PITCHBOX_ASSIST_ORG_ID ' +
                  'must be set before a tool call',
              },
            ],
          };
        }
        const { observedTarget, operator } = await loadPayload();
        const toolCtx: AssistToolContext = {
          db: getDb(),
          orgId: organizationId,
          boundProjectId: boundProjectId ?? null,
          observedTarget,
          operator,
        };
        try {
          const answer = await tool.handler(toolCtx, args, extra?.signal);
          return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }] };
        } catch (err) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: String(err instanceof Error ? err.message : err) },
            ],
          };
        }
      },
    );
  }

  return server;
}
