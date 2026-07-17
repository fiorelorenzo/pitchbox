import type { ParsedEvent } from '../runlog/types.js';

export interface AgentRunOptions {
  playbookPath: string;
  slug: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  /**
   * The dispatching run's organization, when resolved. Only the `cloud` runner
   * consumes this today (to mint a per-org runner-auth JWT at dispatch time);
   * other runners ignore it.
   */
  orgId?: number;
  /** Called with the raw original line for each stdout/stderr chunk - optional, for forensic logging. */
  onRawLine?: (line: string) => void;
  /** Called with one or more normalized ParsedEvents extracted from that line. */
  onParsedEvents?: (events: ParsedEvent[]) => void | Promise<void>;
}

export interface AgentRunResult {
  exitCode: number;
  logPath: string;
  tokensUsed?: number;
  /** Detailed token usage + USD cost extracted from the runner's `result`/`usage` block. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Null when not self-reported and pricing for the run's model/backend is unknown. */
    costUsd: number | null;
    costReported: boolean;
  };
}

export interface AgentRunHandle {
  result: Promise<AgentRunResult>;
  cancel: () => void;
}

export interface AgentRunner {
  slug: string;
  run(opts: AgentRunOptions): AgentRunHandle;
}
