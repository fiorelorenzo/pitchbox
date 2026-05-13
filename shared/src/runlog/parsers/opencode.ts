import type { ParsedEvent } from '../types.js';
import { tryParseCliEnvelope } from './claude-code.js';

/**
 * Parses one line of OpenCode CLI (`opencode run --json ...`) stream output
 * into normalized events.
 *
 * ASSUMPTIONS (OpenCode CLI from sst/opencode; exact JSON schema may vary
 * across versions). We accept several shapes we expect or have observed:
 *
 *   { "type": "session.start" | "session.end", "session_id": "...", "model": "..." }
 *   { "type": "message.start" | "message.delta" | "message.end",
 *     "role": "assistant" | "user", "content": "..." }
 *   { "type": "tool.start", "tool": "bash" | "read", "input": {...}, "id": "..." }
 *   { "type": "tool.end", "tool": "bash", "output": "...", "is_error": false, "id": "..." }
 *   { "type": "session.end", "usage": { "input_tokens": N, "output_tokens": N }, "cost_usd": 1.23 }
 *   { "type": "error", "message": "..." }
 *
 * `message.start` is ignored (no content yet); `message.delta` and
 * `message.end` both emit assistant events so streaming text is preserved.
 * Unknown shapes fall through to a single `unknown` event so the run timeline
 * still records the raw line.
 */
export function parseOpenCodeLine(line: string, seqStart = 0): ParsedEvent[] {
  if (!line.trim()) return [];
  if (line.startsWith('#')) return [];

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return [];
  }

  const t = (evt.type ?? evt.event) as string | undefined;
  const results: ParsedEvent[] = [];
  const nextSeq = () => seqStart + results.length;

  switch (t) {
    case 'session.start':
    case 'session.created':
    case 'session': {
      const s = evt as { session_id?: string; sessionId?: string; model?: string; cwd?: string };
      results.push({
        seq: nextSeq(),
        kind: 'session',
        raw: line,
        payload: {
          type: 'session',
          sessionId: s.session_id ?? s.sessionId,
          model: s.model,
          cwd: s.cwd,
        },
      });
      return results;
    }
    case 'message.start':
      // No content yet — skip; message.delta/message.end will emit.
      return results;
    case 'message.delta':
    case 'message.end':
    case 'message': {
      const m = evt as { role?: string; content?: string; text?: string };
      const text = m.content ?? m.text;
      if (!text) return results;
      if (m.role === 'assistant' || m.role == null) {
        results.push({
          seq: nextSeq(),
          kind: 'assistant',
          raw: line,
          payload: { type: 'assistant', text },
        });
      }
      return results;
    }
    case 'thinking':
    case 'reasoning': {
      const text = (evt.text ?? evt.content) as string | undefined;
      if (text) {
        results.push({
          seq: nextSeq(),
          kind: 'thinking',
          raw: line,
          payload: { type: 'thinking', text },
        });
      }
      return results;
    }
    case 'tool.start':
    case 'tool_call': {
      const c = evt as { tool?: string; name?: string; input?: unknown; id?: string };
      results.push({
        seq: nextSeq(),
        kind: 'tool-call',
        raw: line,
        payload: {
          type: 'tool-call',
          name: c.tool ?? c.name ?? 'tool',
          input: (c.input as Record<string, unknown>) ?? {},
          id: c.id,
        },
      });
      return results;
    }
    case 'tool.end':
    case 'tool_result': {
      const c = evt as {
        output?: unknown;
        content?: unknown;
        text?: unknown;
        is_error?: boolean;
        id?: string;
        tool_use_id?: string;
      };
      const raw = c.output ?? c.content ?? c.text ?? '';
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      results.push({
        seq: nextSeq(),
        kind: 'tool-result',
        raw: line,
        payload: {
          type: 'tool-result',
          raw,
          text,
          parsedEnvelope: tryParseCliEnvelope(text),
          isError: !!c.is_error,
          toolUseId: c.tool_use_id ?? c.id,
        },
      });
      return results;
    }
    case 'session.end':
    case 'done':
    case 'turn_complete': {
      const r = evt as {
        usage?: { input_tokens?: number; output_tokens?: number };
        cost_usd?: number;
        total_cost_usd?: number;
        duration_ms?: number;
        num_turns?: number;
        text?: string;
        message?: string;
      };
      const u = r.usage ?? {};
      results.push({
        seq: nextSeq(),
        kind: 'result',
        raw: line,
        payload: {
          type: 'result',
          success: true,
          text: r.text ?? r.message,
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          totalCostUsd: r.cost_usd ?? r.total_cost_usd,
          durationMs: r.duration_ms,
          numTurns: r.num_turns,
        },
      });
      return results;
    }
    case 'error': {
      results.push({
        seq: nextSeq(),
        kind: 'result',
        raw: line,
        payload: {
          type: 'result',
          success: false,
          text: (evt.message ?? evt.error ?? 'OpenCode error') as string,
        },
      });
      return results;
    }
  }

  results.push({
    seq: nextSeq(),
    kind: 'unknown',
    raw: line,
    payload: { type: 'unknown', eventType: t ?? 'event', raw: line },
  });
  return results;
}
