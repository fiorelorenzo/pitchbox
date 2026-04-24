import type { ParsedEvent } from '../runlog/types.js';

export interface AgentRunOptions {
  playbookPath: string;
  slug: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  /** Called with the raw original line for each stdout/stderr chunk — optional, for forensic logging. */
  onRawLine?: (line: string) => void;
  /** Called with one or more normalized ParsedEvents extracted from that line. */
  onParsedEvents?: (events: ParsedEvent[]) => void | Promise<void>;
}

export interface AgentRunResult {
  exitCode: number;
  logPath: string;
  tokensUsed?: number;
}

export interface AgentRunHandle {
  result: Promise<AgentRunResult>;
  cancel: () => void;
}

export interface AgentRunner {
  slug: string;
  run(opts: AgentRunOptions): AgentRunHandle;
}
