// Wire protocol between a Pitchbox cloud-runner CLIENT (the box that holds the
// data and the local Pitchbox MCP server) and the RUNNER SERVICE (stateless
// compute that spawns the agent and owns the LLM subscription).
//
// The CLIENT initiates the WebSocket (outbound), so a self-hosted box needs no
// inbound port. One connection carries three concerns, multiplexed:
//   1. session control (start / cancel / done),
//   2. agent events flowing DOWN (the agent's `session/update`; the client
//      normalizes them with the existing event-normalizer and persists them),
//   3. a transparent MCP tunnel: the agent (in the runner) talks to an HTTP MCP
//      relay; every MCP JSON-RPC frame is forwarded over this connection to the
//      client's local Pitchbox MCP server and back, so all data operations run
//      where the data lives.
//
// Connection auth is handled at the WebSocket handshake (a per-org bearer token
// in the `Authorization` header), out of band of these message types.
//
// This contract lives in the OSS repo because it is a contract, not a secret:
// the private runner service and the private cloud adapter both import it so the
// two sides stay in lockstep without sharing implementation (see
// docs/cloud-runner.md).

export const CLOUD_PROTOCOL_VERSION = 1;

/** What the client binds the run to; mirrors the env the local MCP server reads. */
export interface CloudSessionContext {
  campaignId?: number;
  runId?: number;
  projectId?: number;
  /** Extra env to forward to the run (e.g. PITCHBOX_REPLY_DRAFT_ID). */
  env?: Record<string, string>;
}

/**
 * A raw MCP JSON-RPC frame tunnelled verbatim in either direction. The runner
 * never inspects it; it bridges the agent's HTTP MCP transport to this socket,
 * and the client bridges this socket to its local Pitchbox MCP server.
 */
export type McpFrame = unknown;

/** Messages the client sends up to the runner. */
export type ClientToRunner =
  | {
      t: 'session.start';
      sessionId: string;
      /** Agent backend slug to spawn (e.g. 'claude-code'). */
      backend: string;
      /** Playbook markdown the agent executes. */
      playbook: string;
      /** Playbook slug, used to frame the prompt. */
      slug: string;
      context: CloudSessionContext;
      timeoutMs: number;
    }
  /** An MCP frame from the client's local MCP server, going up to the agent. */
  | { t: 'mcp'; sessionId: string; frame: McpFrame }
  | { t: 'session.cancel'; sessionId: string };

/** Messages the runner sends down to the client. */
export type RunnerToClient =
  | { t: 'session.ready'; sessionId: string }
  /** An agent `session/update`; the client normalizes + persists it. */
  | { t: 'session.event'; sessionId: string; update: unknown }
  /** An MCP frame from the agent, going down to the client's local MCP server. */
  | { t: 'mcp'; sessionId: string; frame: McpFrame }
  | { t: 'session.done'; sessionId: string; stopReason: string; usage?: CloudUsage }
  | { t: 'session.error'; sessionId: string; message: string };

/** Token/cost usage the runner meters and reports back on `session.done`. */
export interface CloudUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd?: number;
}

/** Type guard helpers kept tiny so both sides can narrow without a parser. */
export function isClientToRunner(m: unknown): m is ClientToRunner {
  return !!m && typeof (m as { t?: unknown }).t === 'string';
}
export function isRunnerToClient(m: unknown): m is RunnerToClient {
  return !!m && typeof (m as { t?: unknown }).t === 'string';
}
