// Wire protocol between a Pitchbox cloud-runner CLIENT (the box that holds the
// data and the local Pitchbox MCP server) and the RUNNER SERVICE (stateless
// compute that spawns the agent and owns the LLM subscription).
//
// The CLIENT initiates the WebSocket (outbound), so a self-hosted box needs no
// inbound port. One connection carries three concerns, multiplexed:
//   1. session control (start / cancel / done / resume),
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
// Resumable sessions (v2, see docs/cloud-runner-productionization-design.md
// section 3): every RunnerToClient frame carries a per-session monotonic `seq`
// the runner assigns. On an unexpected disconnect, the runner holds the session
// open for a grace window instead of tearing it down immediately, buffering
// frames it sends in the meantime. A client that reconnects within that window
// sends `session.resume { sessionId, lastSeq, version }` instead of
// `session.start`; the runner replays any buffered frames with `seq > lastSeq`
// and resumes live forwarding. Resume is strictly same-instance - a runner that
// has no matching live session (unknown id, already terminal, or grace expired)
// rejects it with `session.error`.
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

export const CLOUD_PROTOCOL_VERSION = 2;

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
  | { t: 'session.cancel'; sessionId: string }
  /**
   * Reconnect to a still-live session on the same runner instance instead of
   * starting a new one. `lastSeq` is the highest `seq` the client has durably
   * processed; the runner replays buffered frames with `seq > lastSeq`. Like
   * `session.start`, `version` is checked at the handshake and a mismatch is
   * rejected. A runner with no matching live session (unknown id, already
   * terminal, or its grace window expired) replies with `session.error`.
   */
  | { t: 'session.resume'; sessionId: string; lastSeq: number; version: number };

/** Messages the runner sends down to the client. Every variant carries a
 * per-session monotonic `seq` the runner assigns, so the client can dedup
 * replayed frames on reconnect (see `session.resume` above). */
export type RunnerToClient =
  | { t: 'session.ready'; sessionId: string; seq: number }
  /** An agent `session/update`; the client normalizes + persists it. */
  | { t: 'session.event'; sessionId: string; update: unknown; seq: number }
  /** An MCP frame from the agent, going down to the client's local MCP server. */
  | { t: 'mcp'; sessionId: string; frame: McpFrame; seq: number }
  | { t: 'session.done'; sessionId: string; stopReason: string; usage?: CloudUsage; seq: number }
  | { t: 'session.error'; sessionId: string; message: string; seq: number };

/** Token/cost usage the runner meters and reports back on `session.done`. */
export interface CloudUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd?: number;
}

/**
 * Claims carried by the short-lived, per-org runner-auth JWT that replaces the
 * static `RUNNER_TOKEN` bearer for multi-tenant deployments (see
 * docs/cloud-runner-productionization-design.md section 1). The client/control
 * plane signs a token with these claims (`RUNNER_JWT_PRIVATE_KEY`) and the
 * runner verifies it (`RUNNER_JWT_PUBLIC_KEY`) at the WS handshake, extracting
 * `org_id` to scope usage metering. Kept here - not next to the `jose`-based
 * signer/verifier - so the shape stays dependency-free and vendors cleanly into
 * the runner via `pnpm sync:protocol`; each side owns its own signing/verifying
 * code and only agrees on this shape.
 */
export interface RunnerJwtClaims {
  /** The organization this token authorizes; the runner tags metered usage with it. */
  org_id: number;
  /** Standard JWT "issued at" claim, Unix seconds. */
  iat: number;
  /** Standard JWT "expires at" claim, Unix seconds. Intentionally short (see
   * `RUNNER_JWT_DEFAULT_TTL_SECONDS`) since revocation beyond expiry is
   * TTL-only for now (no deny-list). */
  exp: number;
  /** Standard JWT token id. Not checked against a deny-list today; reserved
   * for one if a "revoke now" requirement appears. */
  jti: string;
  /** Token scope. Always `RUNNER_JWT_SCOPE` today. */
  scope: string;
  /**
   * CLD-P5 (per-org quota enforcement, see
   * docs/cloud-runner-productionization-design.md section 5): a snapshot of
   * the org's remaining monthly USD budget and concurrency cap, taken at mint
   * time by the client/control plane (`shared/src/org-quota.ts`). The runner
   * enforces both at `session.start` admission (`cloud/runner/src/server.ts`)
   * purely from this signed claim - it never queries a DB. Because tokens are
   * short-lived, the snapshot is at most one TTL stale. Omitted (undefined)
   * only on the legacy static-token fallback path, which carries no org
   * identity and so is never quota-enforced.
   */
  quota?: RunnerJwtQuota;
}

/**
 * The quota snapshot carried by `RunnerJwtClaims.quota`. Both fields are
 * independently nullable: `null` means unlimited on that axis (no budget cap
 * / no concurrency cap), distinct from `undefined` (no claim at all, the
 * static-token fallback path).
 */
export interface RunnerJwtQuota {
  /** Org's remaining monthly USD run budget at mint time, or null if the org
   * has no configured budget (unlimited). A value <= 0 means the org is over
   * budget - the runner rejects `session.start` with a `quota_exceeded` reason. */
  remainingUsd: number | null;
  /** Max concurrent sessions the runner allows for this org, or null if
   * unlimited. Enforced by the runner's in-memory per-org session count. */
  concurrencyCap: number | null;
}

/** The only scope a runner-auth JWT carries today. */
export const RUNNER_JWT_SCOPE = 'runner:dispatch';

/** Default TTL for a minted runner-auth JWT, in seconds (short-lived by design). */
export const RUNNER_JWT_DEFAULT_TTL_SECONDS = 15 * 60;

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
function isNullable<T>(v: unknown, check: (v: unknown) => v is T): v is T | null {
  return v === null || check(v);
}

/**
 * Validates the `quota` claim shape carried by `RunnerJwtClaims`. The runner's
 * JWT verification (`cloud/runner/src/auth.ts`) calls this to reject a
 * malformed claim before it is trusted for an admission decision - a claim is
 * only ever a signed artifact from the control plane, but shape validation
 * here is cheap insurance against a stale/mismatched mint.
 */
export function isRunnerJwtQuota(v: unknown): v is RunnerJwtQuota {
  if (!isRecord(v)) return false;
  return isNullable(v.remainingUsd, isFiniteNumber) && isNullable(v.concurrencyCap, isFiniteNumber);
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
    case 'session.resume':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.resume: missing sessionId' };
      if (!isFiniteNumber(m.lastSeq))
        return { valid: false, reason: 'session.resume: invalid lastSeq' };
      if (!isFiniteNumber(m.version))
        return { valid: false, reason: 'session.resume: invalid version' };
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
      if (!isFiniteNumber(m.seq)) return { valid: false, reason: 'session.ready: invalid seq' };
      return { valid: true, value: m as RunnerToClient };
    case 'session.event':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.event: missing sessionId' };
      if (!('update' in m)) return { valid: false, reason: 'session.event: missing update' };
      if (!isFiniteNumber(m.seq)) return { valid: false, reason: 'session.event: invalid seq' };
      return { valid: true, value: m as RunnerToClient };
    case 'mcp':
      if (!isString(m.sessionId)) return { valid: false, reason: 'mcp: missing sessionId' };
      if (!('frame' in m)) return { valid: false, reason: 'mcp: missing frame' };
      if (!isFiniteNumber(m.seq)) return { valid: false, reason: 'mcp: invalid seq' };
      return { valid: true, value: m as RunnerToClient };
    case 'session.done':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.done: missing sessionId' };
      if (!isString(m.stopReason))
        return { valid: false, reason: 'session.done: missing stopReason' };
      if (!isOptional(m.usage, isCloudUsage))
        return { valid: false, reason: 'session.done: invalid usage' };
      if (!isFiniteNumber(m.seq)) return { valid: false, reason: 'session.done: invalid seq' };
      return { valid: true, value: m as RunnerToClient };
    case 'session.error':
      if (!isString(m.sessionId))
        return { valid: false, reason: 'session.error: missing sessionId' };
      if (!isString(m.message)) return { valid: false, reason: 'session.error: missing message' };
      if (!isFiniteNumber(m.seq)) return { valid: false, reason: 'session.error: invalid seq' };
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
