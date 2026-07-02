// shared/src/agents/acp/event-normalizer.ts
import type { ParsedEvent } from '../../runlog/types.js';

// Shape names here mirror the ACP spec's `session/update` notification payload.
// The SDK exports stronger types - we accept `unknown` so this stays robust
// against payload drift across backends.

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd?: number;
}

export type AcpStopReasonKind =
  'end_turn' | 'cancelled' | 'error' | 'max_turn_requests' | 'refusal';

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function extractText(content: unknown): string {
  const c = asRecord(content);
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'text' && typeof (c as { text?: unknown }).text === 'string') {
    return (c as { text: string }).text;
  }
  return '';
}

function joinContent(content: unknown): string {
  if (!Array.isArray(content)) return extractText(content);
  return content
    .map((part) => {
      const p = asRecord(part);
      if (!p) return '';
      if (typeof p.text === 'string') return p.text;
      return extractText(p.content);
    })
    .filter(Boolean)
    .join('\n');
}

// Map ACP's coarse `kind` taxonomy back to the friendly Claude-style tool
// names the runlog UI already knows how to render (Bash, Read, Edit, etc).
// The UI dispatches on `data.name.toLowerCase()` against literal strings,
// so we have to produce names that match those branches.
function toolNameFromAcp(u: Record<string, unknown>): string {
  const kind = typeof u.kind === 'string' ? u.kind : undefined;
  switch (kind) {
    case 'execute':
      return 'Bash';
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'search':
      return 'Grep';
    case 'fetch':
      return 'WebFetch';
    case 'think':
      return 'Think';
    case 'switch_mode':
      return 'SwitchMode';
    default:
      // Unknown kind: fall back to title if it looks usable.
      if (typeof u.title === 'string' && u.title.length > 0) return u.title;
      return kind ?? 'tool';
  }
}

// Tool output may arrive as a `content` array (rich blocks the agent rendered
// for the user) or as `rawOutput` (raw JSON envelope from the underlying tool
// invocation). Prefer the rendered text; fall back to rawOutput JSON.
function extractToolOutput(u: Record<string, unknown>): string {
  if (Array.isArray(u.content) && u.content.length > 0) {
    const joined = joinContent(u.content);
    if (joined) return joined;
  }
  if (typeof u.rawOutput === 'string') return u.rawOutput;
  if (u.rawOutput && typeof u.rawOutput === 'object') {
    try {
      return JSON.stringify(u.rawOutput);
    } catch {
      return '';
    }
  }
  return '';
}

export function normalizeAcpUpdate(update: unknown, raw: string, seq: number): ParsedEvent[] {
  const u = asRecord(update);
  if (!u) return [];
  const kind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : undefined;
  if (!kind) return [];

  switch (kind) {
    case 'agent_message_chunk': {
      const text = extractText(u.content);
      return [{ seq, kind: 'assistant', payload: { type: 'assistant', text }, raw }];
    }
    case 'agent_thought_chunk': {
      const text = extractText(u.content);
      return [{ seq, kind: 'thinking', payload: { type: 'thinking', text }, raw }];
    }
    case 'tool_call': {
      // Anthropic's adapter often emits an initial `tool_call` with empty
      // `rawInput` and a generic title (e.g. "Terminal"), then sends the real
      // input via a follow-up `tool_call_update`. Suppress placeholders;
      // emit only if input is already populated.
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : undefined;
      const input = asRecord(u.rawInput) ?? {};
      if (Object.keys(input).length === 0) return [];
      const name = toolNameFromAcp(u);
      return [{ seq, kind: 'tool-call', payload: { type: 'tool-call', id, name, input }, raw }];
    }
    case 'tool_call_update': {
      const toolUseId = typeof u.toolCallId === 'string' ? u.toolCallId : undefined;
      const status = typeof u.status === 'string' ? u.status : undefined;
      const input = asRecord(u.rawInput);
      const events: ParsedEvent[] = [];

      // If this update fills in rawInput (without yet being a completion),
      // synthesize the `tool-call` event we suppressed earlier.
      if (input && Object.keys(input).length > 0 && status !== 'completed' && status !== 'failed') {
        const name = toolNameFromAcp(u);
        events.push({
          seq,
          kind: 'tool-call',
          payload: { type: 'tool-call', id: toolUseId, name, input },
          raw,
        });
      }

      // If status signals completion, emit the paired `tool-result`.
      if (status === 'completed' || status === 'failed') {
        const isError = status === 'failed';
        const text = extractToolOutput(u);
        events.push({
          seq: seq + events.length,
          kind: 'tool-result',
          payload: {
            type: 'tool-result',
            raw: u.content ?? u.rawOutput,
            text,
            isError,
            toolUseId,
          },
          raw,
        });
      }

      // If the update is purely cosmetic (title-only, no input, no status),
      // skip it - the UI has nothing to render from it.
      return events;
    }
    default:
      return [{ seq, kind: 'unknown', payload: { type: 'unknown', eventType: kind, raw }, raw }];
  }
}

export function normalizeStopReason(
  reason: AcpStopReasonKind | string,
  usage: AcpUsage | undefined,
  raw: string,
  seq: number,
): ParsedEvent[] {
  const success = reason === 'end_turn';
  return [
    {
      seq,
      kind: 'result',
      payload: {
        type: 'result',
        success,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheCreationTokens: usage?.cacheCreationTokens,
        totalCostUsd: usage?.totalCostUsd,
      },
      raw,
    },
  ];
}
