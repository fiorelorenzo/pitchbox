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
  | 'end_turn'
  | 'cancelled'
  | 'error'
  | 'max_turn_requests'
  | 'refusal';

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
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : undefined;
      const name =
        typeof u.kind === 'string' ? u.kind : typeof u.title === 'string' ? u.title : 'tool';
      const input = asRecord(u.rawInput) ?? {};
      return [{ seq, kind: 'tool-call', payload: { type: 'tool-call', id, name, input }, raw }];
    }
    case 'tool_call_update': {
      const toolUseId = typeof u.toolCallId === 'string' ? u.toolCallId : undefined;
      const status = typeof u.status === 'string' ? u.status : undefined;
      const isError = status === 'failed';
      const text = joinContent(u.content);
      return [
        {
          seq,
          kind: 'tool-result',
          payload: { type: 'tool-result', raw: u.content, text, isError, toolUseId },
          raw,
        },
      ];
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
