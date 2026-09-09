import type { ParsedEvent } from './types.js';

/**
 * Structured run-failure taxonomy.
 *
 * Stored in `runs.failure_reason` whenever a run transitions to `failed`. The
 * dashboard's campaigns detail page filters/groups failed runs by this value.
 * Kept as a TypeScript union (not a Postgres enum) so growing the taxonomy
 * doesn't require a schema migration.
 */
export type RunFailureReason =
  | 'runner_missing'
  | 'auth_expired'
  | 'quota_exhausted'
  | 'instance_quota_exhausted'
  | 'concurrency_exhausted'
  | 'playbook_error'
  | 'playbook_incomplete'
  | 'network'
  | 'agent_crashed'
  | 'agent_timeout'
  | 'cancelled'
  | 'provider_error'
  | 'step_limit_reached'
  | 'content_filtered'
  | 'unknown';

export const RUN_FAILURE_REASONS: readonly RunFailureReason[] = [
  'runner_missing',
  'auth_expired',
  'quota_exhausted',
  'instance_quota_exhausted',
  'concurrency_exhausted',
  'playbook_error',
  'playbook_incomplete',
  'network',
  'agent_crashed',
  'agent_timeout',
  'cancelled',
  'provider_error',
  'step_limit_reached',
  'content_filtered',
  'unknown',
] as const;

export function isRunFailureReason(v: unknown): v is RunFailureReason {
  return typeof v === 'string' && (RUN_FAILURE_REASONS as readonly string[]).includes(v);
}

/**
 * Extract all human-readable text we can find in a parsed event. We look at
 * the `raw` field plus any `text` / `error` field on the payload, so the
 * heuristics below can match on substrings without caring which event kind
 * produced them.
 */
function eventHaystack(ev: ParsedEvent): string {
  const parts: string[] = [ev.raw ?? ''];
  const p = ev.payload as Record<string, unknown> | null;
  if (p) {
    for (const key of ['text', 'error', 'eventType']) {
      const v = p[key];
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join('\n').toLowerCase();
}

const AUTH_PATTERNS = [
  'auth', // matches "auth_expired", "authentication", "authorization"
  '401',
  '403',
  'token expired',
  'expired token',
  'unauthorized',
  'forbidden',
];

const QUOTA_PATTERNS = [
  'quota',
  'rate limit', // distinct from runlog "rate-limit" kind: this catches text mentions
  'rate-limit',
];

// #540: the instance-wide monthly Gateway ceiling (checked in
// web/src/lib/server/runner.ts next to the per-org budget above,
// shared/src/org-quota.ts's getInstanceQuotaSnapshot) is a different
// failure from an org's own budget - "this tenant is out of budget" is on
// the operator's tenant, "the instance is out of budget" is on the
// operator running the deployment. Its refusal text deliberately says
// "instance-wide" rather than "quota", so it needs its own pattern and its
// own reason rather than folding into `quota_exhausted`.
const INSTANCE_QUOTA_PATTERNS = ['instance-wide'];

// #485: the org's concurrency cap (organizations.max_concurrent_runs) is a
// different failure than the budget above - "you already have N runs going"
// has a different fix (wait or raise the cap) than "you are out of money
// this month" (wait for next month or raise the budget) - so the refusal
// text in assertOrgConcurrencyAdmitted (shared/src/org-quota.ts) deliberately
// never says "quota" or "rate limit" and needs its own pattern here.
const CONCURRENCY_PATTERNS = ['concurrency limit'];

const NETWORK_PATTERNS = [
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'network error',
  'fetch failed',
  'getaddrinfo',
  'socket hang up',
];

const RUNNER_MISSING_PATTERNS = ['command not found', 'enoent', 'no such file or directory'];

const STACK_TRACE_PATTERNS = [
  '\n    at ', // node-style "at File.fn (path:line:col)"
  'traceback (most recent call last)',
];

// Markers the SDK event normalizer (shared/src/agents/sdk/event-normalizer.ts)
// embeds into the closing `result` event's raw/text for outcomes an ACP
// backend never produces: a `streamText` call aborted by the client or by
// its own timeoutMs never throws (#415, docs/cloud-runner.md), and a
// stopWhen(stepCountIs(n)) ceiling is not a crash either - both need a
// specific marker rather than falling through to `unknown`.
const CANCELLED_PATTERNS = ['run cancelled: aborted by the client'];

const SDK_TIMEOUT_PATTERNS = ['exceeded its time limit'];

const STEP_LIMIT_PATTERNS = ['step limit reached before the agent finished'];

const PROVIDER_ERROR_PATTERNS = ['provider error'];

const CONTENT_FILTERED_PATTERNS = ['the model refused to continue'];

/**
 * Pure classifier mapping (events, exit code) to a structured failure reason.
 *
 * Heuristic order matters: runner-missing is checked first because an ENOENT
 * looks like a generic playbook error otherwise. The SDK-specific markers
 * (cancelled / timeout / step limit) are checked next since they are
 * synthesized substrings unique to `normalizeStopReason`'s own output and
 * never collide with anything else. Auth / quota / network are scanned
 * before the generic `provider_error` catch-all so a provider error whose
 * own message is actually about auth or quota still gets the more specific
 * reason. playbook_error catches anything that still has a recognisable
 * stack trace. Everything else falls back to `unknown` so the UI never has
 * to deal with a null reason on a failed run.
 */
export function classifyFailure(events: ParsedEvent[], exitCode: number | null): RunFailureReason {
  const failed = exitCode == null || exitCode !== 0;
  if (!failed) return 'unknown';

  const haystack = events.map(eventHaystack).join('\n');

  if (RUNNER_MISSING_PATTERNS.some((p) => haystack.includes(p))) return 'runner_missing';
  if (CANCELLED_PATTERNS.some((p) => haystack.includes(p))) return 'cancelled';
  if (STEP_LIMIT_PATTERNS.some((p) => haystack.includes(p))) return 'step_limit_reached';
  if (SDK_TIMEOUT_PATTERNS.some((p) => haystack.includes(p))) return 'agent_timeout';
  if (AUTH_PATTERNS.some((p) => haystack.includes(p))) return 'auth_expired';
  if (INSTANCE_QUOTA_PATTERNS.some((p) => haystack.includes(p))) return 'instance_quota_exhausted';
  if (QUOTA_PATTERNS.some((p) => haystack.includes(p))) return 'quota_exhausted';
  if (CONCURRENCY_PATTERNS.some((p) => haystack.includes(p))) return 'concurrency_exhausted';
  if (NETWORK_PATTERNS.some((p) => haystack.includes(p))) return 'network';
  if (PROVIDER_ERROR_PATTERNS.some((p) => haystack.includes(p))) return 'provider_error';
  if (CONTENT_FILTERED_PATTERNS.some((p) => haystack.includes(p))) return 'content_filtered';
  if (STACK_TRACE_PATTERNS.some((p) => haystack.includes(p))) return 'playbook_error';

  return 'unknown';
}
