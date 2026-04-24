// Re-export shared types so client code keeps importing from this module.
export type { EventKind, CliEnvelope, ParsedEvent, EventPayload } from '@pitchbox/shared/runlog';

/** Client-side timeline event: adds id (local), ts (epoch ms), and collapsed state. */
export interface TimelineEvent {
  id: number;
  kind: import('@pitchbox/shared/runlog').EventKind;
  ts: number;
  collapsed: boolean;

  // Kind-specific payloads (kept for backward compat with EventRow subcomponents)
  session?: { sessionId?: string; model?: string; cwd?: string };
  assistant?: { text: string };
  thinking?: { text: string };
  toolCall?: { name: string; input: Record<string, unknown>; id?: string };
  toolResult?: {
    raw: unknown;
    text: string;
    parsedEnvelope?: import('@pitchbox/shared/runlog').CliEnvelope | null;
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
