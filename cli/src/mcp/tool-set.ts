import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPClient, type MCPTransport } from '@ai-sdk/mcp';
import { createPitchboxMcpServer, type PitchboxMcpContext } from './server.js';

/**
 * Session binding for the Pitchbox MCP tools: which run, campaign, or project
 * this tool set is scoped to. Identical shape to `PitchboxMcpContext`
 * (./server.ts) - the SDK runner passes it straight through rather than
 * choosing ids itself.
 */
export type PitchboxToolSetArgs = PitchboxMcpContext;

export interface PitchboxToolSet {
  /** The AI SDK tool set, as returned by the MCP client's `tools()`. */
  tools: Record<string, unknown>;
  /** Releases both ends of the in-memory MCP connection. */
  close(): Promise<void>;
}

/**
 * Bridges the Pitchbox MCP server to the Vercel AI SDK's tool interface for
 * the in-process SDK runner (#415/#416): `createPitchboxMcpServer` is
 * connected to one half of an in-memory MCP transport, the AI SDK's MCP
 * client to the other, and the resulting tool set is handed to
 * `streamText`/`generateText` unmodified. The tool list this produces is
 * therefore the same list the ACP path sees (docs/cloud-runner.md, "#415")
 * because it comes from the same registration code, not a second,
 * hand-maintained surface - and the org scoping and ownership checks that
 * live inside those tool handlers (`checkOwnership` in ./server.ts) stay the
 * single enforcement point rather than something this bridge has to
 * reimplement.
 *
 * The session binding travels in `args`, exactly as `createPitchboxMcpServer`
 * expects: an explicit context always wins over env-derived defaults there,
 * which is the path this in-process caller needs - there is no child process
 * to forward PITCHBOX_RUN_ID/PITCHBOX_CAMPAIGN_ID/PITCHBOX_PROJECT_ID to, the
 * way the ACP backend's `buildPitchboxMcpServer` does for a subprocess.
 *
 * Lives in `cli` rather than `shared` deliberately: this is the workspace
 * that already owns the MCP surface and the MCP SDK dependency, and `shared`
 * stays the leaf every other workspace imports rather than the other way
 * around (see AGENTS.md). `shared/src/agents/sdk/tools.ts` re-exports this
 * same name and signature via a lazy `import()`, mirroring how
 * `shared/src/agents/cloud.ts` reaches the private cloud adapter.
 */
export async function createPitchboxToolSet(
  args: PitchboxToolSetArgs = {},
): Promise<PitchboxToolSet> {
  const server = createPitchboxMcpServer(args);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = await createMCPClient({ transport: clientTransport as unknown as MCPTransport });
  const tools = await client.tools();

  return {
    tools,
    async close() {
      // Closing either end of an in-memory pair cascades to the other
      // (InMemoryTransport#close calls its counterpart's close in turn), so
      // this releases both the client and the server side of the
      // connection - a run that finishes or is cancelled does not leave a
      // live server behind. Calling both explicitly (rather than relying on
      // the cascade alone) keeps the guarantee independent of which side
      // happens to close first.
      await client.close();
      await server.close();
    },
  };
}
