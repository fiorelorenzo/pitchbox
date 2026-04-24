import type { TimelineEvent, EventKind, CliEnvelope } from './types';

let nextId = 0;

export function resetParser() {
  nextId = 0;
}

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

function defaultCollapsed(kind: EventKind, isError?: boolean): boolean {
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

export function parse(line: string): TimelineEvent[] {
  if (!line.trim()) return [];
  if (line.startsWith('#')) return [];

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return [];
  }

  const t = evt.type as string | undefined;
  const results: TimelineEvent[] = [];
  const now = Date.now();

  if (t === 'system') {
    const sub = evt.subtype as string | undefined;
    if (sub === 'init') {
      const session = evt as { session_id?: string; model?: string; cwd?: string };
      results.push({
        id: nextId++,
        kind: 'session',
        ts: now,
        collapsed: false,
        session: {
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
            id: nextId++,
            kind: 'thinking',
            ts: now,
            collapsed: true,
            thinking: { text },
          });
        }
      } else if (c.type === 'text') {
        if (c.text) {
          results.push({
            id: nextId++,
            kind: 'assistant',
            ts: now,
            collapsed: false,
            assistant: { text: c.text },
          });
        }
      } else if (c.type === 'tool_use') {
        results.push({
          id: nextId++,
          kind: 'tool-call',
          ts: now,
          collapsed: true,
          toolCall: {
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
          id: nextId++,
          kind: 'tool-result',
          ts: now,
          collapsed: defaultCollapsed('tool-result', isError),
          toolResult: {
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
      id: nextId++,
      kind: 'rate-limit',
      ts: now,
      collapsed: true,
      rateLimit: { info: evt.rate_limit_info ?? evt },
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
      id: nextId++,
      kind: 'result',
      ts: now,
      collapsed: false,
      result: {
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
    id: nextId++,
    kind: 'unknown',
    ts: now,
    collapsed: true,
    unknown: { type: t ?? 'event', raw: line },
  });
  return results;
}
