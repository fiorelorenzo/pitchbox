// shared/src/assist/session.ts (#576)
//
// A retune or a hint-on-a-regenerate continues the loop instead of starting
// over: the operator's typed steer and the retune direction are cheap and
// coherent as a continuation, but only if the model's own gathered tool
// calls and results travel with it (see `suggest-prompt.ts`'s
// `buildRetunePrompt` and `docs/design/in-page-agent.md`). This module is
// where that "gathered" state actually lives between one suggestion and the
// next: a suggestion has no `runs` row and no database home
// (docs/design/in-page-agent.md - "the assist plane's isolation from the
// campaign plane"), so a session is in-memory, per process, and bounded by a
// short lifetime rather than persisted anywhere.
//
// A session id is not a capability by itself: `getAssistSession` also checks
// the org, the project the suggestion is filed under and the suggestion kind
// against the caller's own request, so a foreign or stale id (or a stolen
// device token replaying somebody else's id) never gets to lean on a
// different tenant's gathered context - it falls back to a full re-gather,
// exactly as an expired session does.

import type { ModelMessage } from 'ai';
import type { SuggestionKind } from './suggest-prompt.js';

/**
 * How long a session's gathered context is kept. A human rereads a draft and
 * clicks a retune button within seconds, not minutes - this is generous for
 * that and still short enough that "the page has moved on" (#576's own
 * framing) forces a fresh, honest re-gather rather than answering from a
 * post the human may not even be looking at anymore.
 */
export const ASSIST_SESSION_TTL_MS = 10 * 60 * 1000;

interface AssistSessionEntry {
  messages: ModelMessage[];
  orgId: number | null;
  /** #523: a suggestion with no project bound continues one just as well - a
   * session scoped to `null` matches only another `null`-scoped request,
   * never a real project id or the other way around. */
  projectId: number | null;
  kind: SuggestionKind;
  createdAt: number;
}

interface AssistSessionScope {
  orgId: number | null;
  projectId: number | null;
  kind: SuggestionKind;
}

const sessions = new Map<string, AssistSessionEntry>();

function purgeExpired(now: number): void {
  for (const [id, entry] of sessions) {
    if (now - entry.createdAt > ASSIST_SESSION_TTL_MS) sessions.delete(id);
  }
}

/**
 * Records a turn's own conversation as a continuable session and returns its
 * id. Called after every completed suggestion (fresh or itself a
 * continuation) that ran with a tool set attached, so the *next* retune or
 * hint can continue from it - this is the only writer.
 */
export function createAssistSession(scope: AssistSessionScope, messages: ModelMessage[]): string {
  const now = Date.now();
  purgeExpired(now);
  const id = crypto.randomUUID();
  sessions.set(id, { ...scope, messages, createdAt: now });
  return id;
}

/**
 * Reads back a session for continuation, or `null` when it never existed,
 * expired, or was scoped to a different org/project/kind than this request -
 * every one of those is treated the same way by the caller: fall back to a
 * full re-gather rather than answer from stale or foreign context.
 */
export function getAssistSession(id: string, scope: AssistSessionScope): ModelMessage[] | null {
  const now = Date.now();
  purgeExpired(now);
  const entry = sessions.get(id);
  if (!entry) return null;
  if (
    entry.orgId !== scope.orgId ||
    entry.projectId !== scope.projectId ||
    entry.kind !== scope.kind
  ) {
    return null;
  }
  return entry.messages;
}

/** Frees a session immediately once a newer one supersedes it, rather than
 * waiting on its TTL - keeps the map bounded by live panels, not by how long
 * TTL happens to be. Safe to call with an id that is already gone. */
export function deleteAssistSession(id: string): void {
  sessions.delete(id);
}

/** Test-only: the map above is process-lifetime by design (mirrors the
 * model-catalogue cache in `agents/sdk/runner.ts`), so a suite that creates
 * several sessions across test files needs a way to start clean. Not used by
 * any production code path. */
export function __resetAssistSessionsForTests(): void {
  sessions.clear();
}
