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
  | 'playbook_error'
  | 'network'
  | 'unknown';

export const RUN_FAILURE_REASONS: readonly RunFailureReason[] = [
  'runner_missing',
  'auth_expired',
  'quota_exhausted',
  'playbook_error',
  'network',
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

/**
 * Pure classifier mapping (events, exit code) to a structured failure reason.
 *
 * Heuristic order matters: runner-missing is checked first because an ENOENT
 * looks like a generic playbook error otherwise. Quota / auth / network are
 * scanned next in priority order, and playbook_error catches anything that
 * still has a recognisable stack trace. Everything else falls back to
 * `unknown` so the UI never has to deal with a null reason on a failed run.
 */
export function classifyFailure(events: ParsedEvent[], exitCode: number | null): RunFailureReason {
  const failed = exitCode == null || exitCode !== 0;
  if (!failed) return 'unknown';

  const haystack = events.map(eventHaystack).join('\n');

  if (RUNNER_MISSING_PATTERNS.some((p) => haystack.includes(p))) return 'runner_missing';
  if (AUTH_PATTERNS.some((p) => haystack.includes(p))) return 'auth_expired';
  if (QUOTA_PATTERNS.some((p) => haystack.includes(p))) return 'quota_exhausted';
  if (NETWORK_PATTERNS.some((p) => haystack.includes(p))) return 'network';
  if (STACK_TRACE_PATTERNS.some((p) => haystack.includes(p))) return 'playbook_error';

  return 'unknown';
}
