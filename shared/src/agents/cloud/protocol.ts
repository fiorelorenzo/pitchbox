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
//
// This file is vendored verbatim into the runner service repo (`pnpm
// sync:protocol`), so it must stay dependency-free: hand-written validators
// only, no zod/ajv/etc - adding an external dep here would force the vendored
// copy to install it too.

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
      /** Protocol version the client speaks; the runner rejects a mismatch at handshake. */
      version: number;
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

/** True if `v` is the protocol version this build of the contract speaks. */
export function isSupportedProtocolVersion(v: unknown): v is number {
  return v === CLOUD_PROTOCOL_VERSION;
}

/** Result of validating an inbound frame: either the narrowed value, or why it was rejected. */
export type FrameValidation<T> = { valid: true; value: T } | { valid: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  return Object.values(v).every(isString);
}
function isOptional<T>(v: unknown, check: (v: unknown) => v is T): v is T | undefined {
  return v === undefined || check(v);
}

function isCloudSessionContext(v: unknown): v is CloudSessionContext {
  if (!isRecord(v)) return false;
  return (
    isOptional(v.campaignId, isFiniteNumber) &&
    isOptional(v.runId, isFiniteNumber) &&
    isOptional(v.projectId, isFiniteNumber) &&
    isOptional(v.env, isStringRecord)
  );
}

function isCloudUsage(v: unknown): v is CloudUsage {
  if (!isRecord(v)) return false;
  return (
    isOptional(v.inputTokens, isFiniteNumber) &&
    isOptional(v.outputTokens, isFiniteNumber) &&
    isOptional(v.cacheReadTokens, isFiniteNumber) &&
    isOptional(v.cacheCreationTokens, isFiniteNumber) &&
    isOptional(v.totalCostUsd, isFiniteNumber)
  );
}

/**
 * Validate a frame sent from the client up to the runner, discriminating on
 * `t` and checking every required field's shape (not just its presence).
 */
export function validateClientToRunner(m: unknown): FrameValidation<ClientToRunner> {
  if (!isRecord(m) || !isString(m.t)) {
    return { valid: false, reason: 'not an object with a string "t" field' };
  }
  switch (m.t) {
    case 'session.start':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.start: missing sessionId' };
      if (!isString(m.backend)) return { valid: false, reason: 'session.start: missing backend' };
      if (!isString(m.playbook)) return { valid: false, reason: 'session.start: missing playbook' };
      if (!isString(m.slug)) return { valid: false, reason: 'session.start: missing slug' };
      if (!isCloudSessionContext(m.context))
        return { valid: false, reason: 'session.start: invalid context' };
      if (!isFiniteNumber(m.timeoutMs))
        return { valid: false, reason: 'session.start: invalid timeoutMs' };
      if (!isFiniteNumber(m.version))
        return { valid: false, reason: 'session.start: invalid version' };
      return { valid: true, value: m as ClientToRunner };
    case 'mcp':
      if (!isString(m.sessionId)) return { valid: false, reason: 'mcp: missing sessionId' };
      if (!('frame' in m)) return { valid: false, reason: 'mcp: missing frame' };
      return { valid: true, value: m as ClientToRunner };
    case 'session.cancel':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.cancel: missing sessionId' };
      return { valid: true, value: m as ClientToRunner };
    default:
      return { valid: false, reason: `unknown message type "${m.t}"` };
  }
}

/**
 * Validate a frame sent from the runner down to the client, discriminating on
 * `t` and checking every required field's shape (not just its presence).
 */
export function validateRunnerToClient(m: unknown): FrameValidation<RunnerToClient> {
  if (!isRecord(m) || !isString(m.t)) {
    return { valid: false, reason: 'not an object with a string "t" field' };
  }
  switch (m.t) {
    case 'session.ready':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.ready: missing sessionId' };
      return { valid: true, value: m as RunnerToClient };
    case 'session.event':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.event: missing sessionId' };
      if (!('update' in m)) return { valid: false, reason: 'session.event: missing update' };
      return { valid: true, value: m as RunnerToClient };
    case 'mcp':
      if (!isString(m.sessionId)) return { valid: false, reason: 'mcp: missing sessionId' };
      if (!('frame' in m)) return { valid: false, reason: 'mcp: missing frame' };
      return { valid: true, value: m as RunnerToClient };
    case 'session.done':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.done: missing sessionId' };
      if (!isString(m.stopReason))
        return { valid: false, reason: 'session.done: missing stopReason' };
      if (!isOptional(m.usage, isCloudUsage))
        return { valid: false, reason: 'session.done: invalid usage' };
      return { valid: true, value: m as RunnerToClient };
    case 'session.error':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.error: missing sessionId' };
      if (!isString(m.message)) return { valid: false, reason: 'session.error: missing message' };
      return { valid: true, value: m as RunnerToClient };
    default:
      return { valid: false, reason: `unknown message type "${m.t}"` };
  }
}

/** Type guard helpers kept tiny so both sides can narrow without inspecting a reason. */
export function isClientToRunner(m: unknown): m is ClientToRunner {
  return validateClientToRunner(m).valid;
}
export function isRunnerToClient(m: unknown): m is RunnerToClient {
  return validateRunnerToClient(m).valid;
}
