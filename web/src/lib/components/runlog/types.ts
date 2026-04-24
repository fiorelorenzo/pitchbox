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

export interface TimelineEvent {
  id: number;
  kind: EventKind;
  ts: number;
  collapsed: boolean;

  // Kind-specific payloads
  session?: { sessionId?: string; model?: string; cwd?: string };
  assistant?: { text: string };
  thinking?: { text: string };
  toolCall?: { name: string; input: Record<string, unknown>; id?: string };
  toolResult?: {
    raw: unknown;
    text: string;
    parsedEnvelope?: CliEnvelope | null;
    isError: boolean;
    toolUseId?: string;
  };
  rateLimit?: { info: unknown };
  result?: {
    success: boolean;
    text?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
    durationMs?: number;
    numTurns?: number;
  };
  unknown?: { type: string; raw: string };
}
