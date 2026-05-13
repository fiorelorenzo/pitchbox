import type { ParsedEvent } from '../types.js';
import { tryParseCliEnvelope } from './claude-code.js';

/**
 * Parses one line of Codex CLI (`codex exec --json ...`) stream output into
 * normalized events.
 *
 * ASSUMPTIONS (Codex CLI is from OpenAI's `@openai/codex`; the exact JSON
 * schema has shifted across versions). We accept several shapes we have
 * observed or can plausibly expect:
 *
 *   { "type": "session_started", "session_id": "...", "model": "gpt-5-codex" }
 *   { "type": "agent_reasoning", "text": "..." }            // thinking
 *   { "type": "agent_message", "text": "..." }              // assistant text
 *   { "type": "tool_call", "name": "shell", "input": {...}, "id": "..." }
 *   { "type": "tool_result", "tool_use_id": "...", "output": "...", "is_error": false }
 *   { "type": "token_count", "input_tokens": N, "output_tokens": N, ... }
 *   { "type": "task_complete" | "error", "message": "..." }
 *
 * If/when the real shape diverges, extend this parser. Unknown shapes fall
 * through to a single `unknown` event so the run timeline still records them.
 */
export function parseCodexLine(line: string, seqStart = 0): ParsedEvent[] {
  if (!line.trim()) return [];
  if (line.startsWith('#')) return [];

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return [];
  }

  const t = (evt.type ?? evt.msg ?? evt.event) as string | undefined;
  const results: ParsedEvent[] = [];
  const nextSeq = () => seqStart + results.length;

  switch (t) {
    case 'session_started':
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
    case 'agent_reasoning':
    case 'reasoning':
    case 'thinking': {
      const text = (evt.text ?? evt.reasoning ?? evt.content) as string | undefined;
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
    case 'agent_message':
    case 'assistant':
    case 'message': {
      const text = (evt.text ?? evt.content ?? evt.message) as string | undefined;
      if (text) {
        results.push({
          seq: nextSeq(),
          kind: 'assistant',
          raw: line,
          payload: { type: 'assistant', text },
        });
      }
      return results;
    }
    case 'tool_call':
    case 'tool_use':
    case 'function_call': {
      const c = evt as { name?: string; input?: unknown; arguments?: unknown; id?: string };
      results.push({
        seq: nextSeq(),
        kind: 'tool-call',
        raw: line,
        payload: {
          type: 'tool-call',
          name: c.name ?? 'tool',
          input: ((c.input ?? c.arguments) as Record<string, unknown>) ?? {},
          id: c.id,
        },
      });
      return results;
    }
    case 'tool_result':
    case 'function_result': {
      const c = evt as {
        output?: unknown;
        content?: unknown;
        text?: unknown;
        is_error?: boolean;
        tool_use_id?: string;
        id?: string;
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
    case 'token_count':
    case 'usage': {
      // Codex usage events arrive incrementally; we surface the latest as a
      // synthetic `result` payload so the runner can aggregate token usage.
      const u = evt as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        total_cost_usd?: number;
      };
      results.push({
        seq: nextSeq(),
        kind: 'result',
        raw: line,
        payload: {
          type: 'result',
          success: true,
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheCreationTokens: u.cache_creation_input_tokens,
          totalCostUsd: u.total_cost_usd,
        },
      });
      return results;
    }
    case 'task_complete':
    case 'turn_complete':
    case 'done': {
      const r = evt as {
        message?: string;
        text?: string;
        input_tokens?: number;
        output_tokens?: number;
        total_cost_usd?: number;
        duration_ms?: number;
        num_turns?: number;
      };
      results.push({
        seq: nextSeq(),
        kind: 'result',
        raw: line,
        payload: {
          type: 'result',
          success: true,
          text: r.message ?? r.text,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          totalCostUsd: r.total_cost_usd,
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
          text: (evt.message ?? evt.error ?? 'Codex error') as string,
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
