// Re-export shared parser + add client-side helpers (id/ts assignment).
export { parseEvent, tryParseCliEnvelope } from '@pitchbox/shared/runlog';
import { parseEvent } from '@pitchbox/shared/runlog';
import type { ParsedEvent } from '@pitchbox/shared/runlog';
import type { TimelineEvent } from './types';

let nextId = 0;

export function resetParser() {
  nextId = 0;
}

function defaultCollapsed(kind: string, isError?: boolean): boolean {
  switch (kind) {
    case 'session':
    case 'assistant':
    case 'result':
      return false;
    case 'tool-result':
      return !isError;
    case 'thinking':
    case 'tool-call':
    case 'rate-limit':
    case 'unknown':
    default:
      return true;
  }
}

/** Convert a ParsedEvent (from shared) into a client TimelineEvent with id/ts/collapsed. */
function toTimelineEvent(pe: ParsedEvent, ts: number): TimelineEvent {
  const id = nextId++;
  const base = { id, kind: pe.kind, ts, collapsed: defaultCollapsed(pe.kind) } as TimelineEvent;

  const p = pe.payload;
  switch (p.type) {
    case 'session':
      return {
        ...base,
        collapsed: false,
        session: { sessionId: p.sessionId, model: p.model, cwd: p.cwd },
      };
    case 'assistant':
      return { ...base, collapsed: false, assistant: { text: p.text } };
    case 'thinking':
      return { ...base, collapsed: true, thinking: { text: p.text } };
    case 'tool-call':
      return { ...base, collapsed: true, toolCall: { name: p.name, input: p.input, id: p.id } };
    case 'tool-result':
      return {
        ...base,
        collapsed: defaultCollapsed('tool-result', p.isError),
        toolResult: {
          raw: p.raw,
          text: p.text,
          parsedEnvelope: p.parsedEnvelope,
          isError: p.isError,
          toolUseId: p.toolUseId,
        },
      };
    case 'rate-limit':
      return { ...base, collapsed: true, rateLimit: { info: p.info } };
    case 'result':
      return {
        ...base,
        collapsed: false,
        result: {
          success: p.success,
          text: p.text,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          totalCostUsd: p.totalCostUsd,
          durationMs: p.durationMs,
          numTurns: p.numTurns,
        },
      };
    case 'unknown':
      return { ...base, collapsed: true, unknown: { type: p.eventType, raw: p.raw } };
    default:
      return { ...base, collapsed: true };
  }
}

/**
 * Parse a raw JSONL line into client-side TimelineEvents.
 * Maintains the module-level `nextId` counter for stable React-style keys.
 */
export function parse(line: string): TimelineEvent[] {
  const now = Date.now();
  const parsed = parseEvent(line, 0);
  return parsed.map((pe) => toTimelineEvent(pe, now));
}

/**
 * Convert a persisted DB event (already parsed) into a client TimelineEvent.
 * Used when hydrating history from the API endpoint.
 */
export function dbEventToTimeline(ev: {
  id: number;
  kind: string;
  payload: unknown;
  ts: string | Date;
}): TimelineEvent {
  const ts = typeof ev.ts === 'string' ? new Date(ev.ts).getTime() : ev.ts.getTime();
  const id = nextId++;
  const kind = ev.kind as TimelineEvent['kind'];
  const base = { id, kind, ts, collapsed: defaultCollapsed(kind) } as TimelineEvent;

  const p = ev.payload as Record<string, unknown>;
  switch (p.type as string) {
    case 'session':
      return {
        ...base,
        collapsed: false,
        session: {
          sessionId: p.sessionId as string | undefined,
          model: p.model as string | undefined,
          cwd: p.cwd as string | undefined,
        },
      };
    case 'assistant':
      return { ...base, collapsed: false, assistant: { text: p.text as string } };
    case 'thinking':
      return { ...base, collapsed: true, thinking: { text: p.text as string } };
    case 'tool-call':
      return {
        ...base,
        collapsed: true,
        toolCall: {
          name: p.name as string,
          input: (p.input as Record<string, unknown>) ?? {},
          id: p.id as string | undefined,
        },
      };
    case 'tool-result': {
      const isError = !!p.isError;
      return {
        ...base,
        collapsed: defaultCollapsed('tool-result', isError),
        toolResult: {
          raw: p.raw,
          text: p.text as string,
          parsedEnvelope:
            (p.parsedEnvelope as
              | import('@pitchbox/shared/runlog').CliEnvelope
              | null
              | undefined) ?? null,
          isError,
          toolUseId: p.toolUseId as string | undefined,
        },
      };
    }
    case 'rate-limit':
      return { ...base, collapsed: true, rateLimit: { info: p.info } };
    case 'result':
      return {
        ...base,
        collapsed: false,
        result: {
          success: p.success as boolean,
          text: p.text as string | undefined,
          inputTokens: p.inputTokens as number | undefined,
          outputTokens: p.outputTokens as number | undefined,
          totalCostUsd: p.totalCostUsd as number | undefined,
          durationMs: p.durationMs as number | undefined,
          numTurns: p.numTurns as number | undefined,
        },
      };
    case 'unknown':
      return {
        ...base,
        collapsed: true,
        unknown: { type: p.eventType as string, raw: p.raw as string },
      };
    default:
      return { ...base, collapsed: true };
  }
}
