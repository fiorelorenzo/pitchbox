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
  /**
   * A tool set to attach directly, bypassing the campaign Pitchbox MCP
   * server (`attachMcp`'s tool set) - the in-page assistant's own tool
   * surface (`shared/src/assist/tools.ts`, #566) is a different plane with
   * different authority (docs/design/in-page-agent.md section 1) and must
   * never share the campaign server's connection or its 26 mostly-writer
   * tools. Wins over `attachMcp` when set. Only the `cloud` runner
   * (`SdkRunner`) reads this; `AcpRunner`'s tool surface for the same plane
   * is wired through a separate stdio MCP entry point instead.
   */
  tools?: Record<string, unknown>;
  /**
   * Step/time/token budget for a native tool-calling loop (#566), enforced
   * only by the `cloud` runner (`SdkRunner`) - `AcpRunner` ignores it exactly
   * as it ignores `budgetRemainingUsd`, since its own coding-agent CLI drives
   * its own turn loop. Past `maxSteps` steps, `softBudgetMs` wall-clock time
   * since this run started, or `tokenBudget` input tokens accumulated across
   * steps, the next step is offered no tools at all: the model is told to
   * answer with whatever it already gathered rather than keep spending
   * (docs/design/in-page-agent.md section 2). This is the soft nudge;
   * `timeoutMs` above stays the hard wall-clock ceiling that aborts the
   * whole run regardless of what streamed.
   */
  toolLoopBudget?: {
    maxSteps: number;
    softBudgetMs: number;
    tokenBudget: number;
  };
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
  /**
   * Remaining monthly USD Gateway budget for the dispatching run's
   * organization, snapshotted at dispatch time
   * (`shared/src/org-quota.ts`'s `getOrgQuotaSnapshot`). Null means
   * unlimited (no budget configured, or the run has no resolved org). Only
   * the `cloud` runner (`SdkRunner`) enforces this, aborting mid-stream once
   * its own accumulated cost would push the org over the line (#419) -
   * other runners spend nothing against the product's Gateway key and
   * ignore it.
   */
  budgetRemainingUsd?: number | null;
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
