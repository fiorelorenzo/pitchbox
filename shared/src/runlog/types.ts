/**
 * Normalized event format used throughout Pitchbox.
 *
 * Every AgentRunner (Claude Code, Codex, OpenCode, ...) must translate its
 * native output stream into a sequence of `ParsedEvent`s matching this shape.
 * The DB (`run_events.payload`), SSE (`run:log` payload), and UI (RunLog)
 * all consume this shape and are entirely agnostic of the underlying runner.
 *
 * To add a new runner:
 *   1. Implement an `AgentRunner` in `shared/src/agents/<slug>.ts`.
 *   2. Implement a line parser in `shared/src/runlog/parsers/<slug>.ts`.
 *   3. Invoke the parser inside the runner's `run()` and feed its output to
 *      `opts.onParsedEvents`.
 */

export type EventKind =
  | 'session'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'assistant'
  | 'rate-limit'
  | 'result'
  | 'unknown';

export interface CliEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
  details?: unknown;
}

/** A parsed event without client-assigned id/ts. seq is assigned by the runner. */
export interface ParsedEvent {
  seq: number;
  kind: EventKind;
  payload: EventPayload;
  /** The original raw line that produced this event. */
  raw: string;
}

export type EventPayload =
  | { type: 'session'; sessionId?: string; model?: string; cwd?: string }
  | { type: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; name: string; input: Record<string, unknown>; id?: string }
  | {
      type: 'tool-result';
      raw: unknown;
      text: string;
      parsedEnvelope?: CliEnvelope | null;
      isError: boolean;
      toolUseId?: string;
    }
  | { type: 'rate-limit'; info: unknown }
  | {
      type: 'result';
      success: boolean;
      text?: string;
      inputTokens?: number;
      outputTokens?: number;
      totalCostUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { type: 'unknown'; eventType: string; raw: string };
