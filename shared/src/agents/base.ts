import type { ParsedEvent } from '../runlog/types.js';

export interface AgentRunOptions {
  /**
   * Path to the markdown the agent executes. Optional only because a
   * playbook-less invocation exists (see `prompt`); every campaign run still
   * passes it. A runner given neither must fail loudly rather than prompt with
   * an empty string.
   */
  playbookPath?: string;
  /**
   * Prompt text supplied directly instead of read from `playbookPath`. Used by
   * the in-page assistant's suggestion endpoint, which has no playbook and no
   * `runs` row: one prompt, one turn, streamed back. Wins over `playbookPath`
   * when both are set.
   */
  prompt?: string;
  /**
   * Whether to attach the Pitchbox MCP server to the session. Defaults to true,
   * which is every campaign run: all state is read and written through it. A
   * suggestion sets this false, because there is nothing for it to write and a
   * tool loop is exactly what a real-time path cannot afford.
   */
  attachMcp?: boolean;
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
  /**
   * Called with each assistant text chunk as it arrives, before any
   * coalescing. `onParsedEvents` deliberately batches chunks into one event per
   * message, which is right for a runlog row and useless for a stream: a reader
   * would get the whole answer at once. A caller that streams to a client uses
   * this instead.
   */
  onTextChunk?: (text: string) => void;
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
