// Client-side helpers that hydrate persisted ParsedEvents into TimelineEvents
// (raw stream parsing now lives in AcpRunner on the server).
import type { CliEnvelope } from '@pitchbox/shared/runlog';
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

/** Extract exit code from Bash tool-result text (e.g. "Exit code 1\n..."). */
export function extractExitCode(text: string): number | undefined {
  const m = /^Exit code (\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Post-process a list of TimelineEvents to pair tool-call and tool-result events.
 * - Tool-result events with a matching tool-call (by toolUseId ↔ id) are merged
 *   into the tool-call as `pairedResult` and removed from the list.
 * - Orphan tool-results (no matching call) are kept as standalone events.
 * - Returns a new array; does not mutate the input.
 */
export function pairToolEvents(events: TimelineEvent[]): TimelineEvent[] {
  // Build a map: toolCallId → index in the output array (populated as we walk)
  const callIndexByToolId = new Map<string, number>();
  const output: TimelineEvent[] = [];

  for (const ev of events) {
    if (ev.kind === 'tool-call' && ev.toolCall) {
      const idx = output.length;
      output.push(ev);
      if (ev.toolCall.id) {
        callIndexByToolId.set(ev.toolCall.id, idx);
      }
    } else if (ev.kind === 'tool-result' && ev.toolResult) {
      const uid = ev.toolResult.toolUseId;
      if (uid && callIndexByToolId.has(uid)) {
        // Merge into the matching tool-call
        const idx = callIndexByToolId.get(uid)!;
        const callEv = output[idx];
        const tr = ev.toolResult;
        const exitCode = extractExitCode(tr.text);
        const isError =
          tr.isError ||
          (exitCode !== undefined && exitCode !== 0) ||
          (tr.parsedEnvelope != null && !tr.parsedEnvelope.ok);
        output[idx] = {
          ...callEv,
          toolCall: {
            ...callEv.toolCall!,
            pairedResult: {
              isError,
              text: tr.text,
              raw: tr.raw,
              parsedEnvelope: (tr.parsedEnvelope as CliEnvelope | null | undefined) ?? null,
              exitCode,
            },
          },
        };
      } else {
        // Orphan tool-result - keep as standalone
        output.push(ev);
      }
    } else {
      output.push(ev);
    }
  }

  return output;
}
