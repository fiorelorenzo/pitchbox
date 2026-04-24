// Shared, stateless event parser — no module-level counters.
// Both the server (runner.ts) and client (RunLog.svelte) import from here.

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

/** A parsed event without client-assigned id/ts. seq is assigned by the caller. */
export interface ParsedEvent {
  seq: number;
  kind: EventKind;
  payload: EventPayload;
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

export function tryParseCliEnvelope(text: string): CliEnvelope | null {
  if (!text.trim().startsWith('{')) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && 'ok' in obj && typeof obj.ok === 'boolean') {
      return obj as CliEnvelope;
    }
  } catch {
    // not JSON
  }
  return null;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: string; text: string } => c && c.type === 'text')
      .map((c) => c.text);
    if (texts.length) return texts.join('\n');
  }
  return JSON.stringify(content, null, 2);
}

/**
 * Parse a single JSONL line from the claude-code runner stream.
 * Returns zero or more ParsedEvent objects. The caller assigns `seq` starting
 * from the provided `seqStart` (default 0).
 */
export function parseEvent(line: string, seqStart = 0): ParsedEvent[] {
  if (!line.trim()) return [];
  if (line.startsWith('#')) return [];

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return [];
  }

  const t = evt.type as string | undefined;
  const results: ParsedEvent[] = [];
  // Helper: seq for next push = seqStart + current results length.
  const nextSeq = () => seqStart + results.length;

  if (t === 'system') {
    const sub = evt.subtype as string | undefined;
    if (sub === 'init') {
      const session = evt as { session_id?: string; model?: string; cwd?: string };
      results.push({
        seq: nextSeq(),
        kind: 'session',
        payload: {
          type: 'session',
          sessionId: session.session_id,
          model: session.model,
          cwd: session.cwd,
        },
      });
    }
    return results;
  }

  if (t === 'assistant') {
    const msg = evt.message as
      | {
          content?: Array<{
            type: string;
            text?: string;
            thinking?: string;
            name?: string;
            id?: string;
            input?: unknown;
          }>;
        }
      | undefined;
    const content = msg?.content ?? [];
    for (const c of content) {
      if (c.type === 'thinking') {
        const text = c.thinking ?? c.text ?? '';
        if (text) {
          results.push({
            seq: nextSeq(),
            kind: 'thinking',
            payload: { type: 'thinking', text },
          });
        }
      } else if (c.type === 'text') {
        if (c.text) {
          results.push({
            seq: nextSeq(),
            kind: 'assistant',
            payload: { type: 'assistant', text: c.text },
          });
        }
      } else if (c.type === 'tool_use') {
        results.push({
          seq: nextSeq(),
          kind: 'tool-call',
          payload: {
            type: 'tool-call',
            name: c.name ?? 'tool',
            input: (c.input as Record<string, unknown>) ?? {},
            id: c.id,
          },
        });
      }
    }
    return results;
  }

  if (t === 'user') {
    const msg = evt.message as
      | {
          content?: Array<{
            type: string;
            content?: unknown;
            is_error?: boolean;
            tool_use_id?: string;
          }>;
        }
      | undefined;
    const content = msg?.content ?? [];
    for (const c of content) {
      if (c.type === 'tool_result') {
        const isError = !!c.is_error;
        const text = extractToolResultText(c.content);
        results.push({
          seq: nextSeq(),
          kind: 'tool-result',
          payload: {
            type: 'tool-result',
            raw: c.content,
            text,
            parsedEnvelope: tryParseCliEnvelope(text),
            isError,
            toolUseId: c.tool_use_id,
          },
        });
      }
    }
    return results;
  }

  if (t === 'rate_limit_event') {
    results.push({
      seq: nextSeq(),
      kind: 'rate-limit',
      payload: { type: 'rate-limit', info: evt.rate_limit_info ?? evt },
    });
    return results;
  }

  if (t === 'result') {
    const r = evt as {
      subtype?: string;
      result?: unknown;
      total_cost_usd?: number;
      duration_ms?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      num_turns?: number;
      is_error?: boolean;
    };
    const success = r.subtype === 'success';
    results.push({
      seq: nextSeq(),
      kind: 'result',
      payload: {
        type: 'result',
        success,
        text: r.result != null ? String(r.result) : undefined,
        inputTokens: r.usage?.input_tokens,
        outputTokens: r.usage?.output_tokens,
        totalCostUsd: r.total_cost_usd,
        durationMs: r.duration_ms,
        numTurns: r.num_turns,
      },
    });
    return results;
  }

  results.push({
    seq: nextSeq(),
    kind: 'unknown',
    payload: { type: 'unknown', eventType: t ?? 'event', raw: line },
  });
  return results;
}
