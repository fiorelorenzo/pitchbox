export interface AgentRunOptions {
  playbookPath: string;
  slug: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  onLogLine?: (line: string) => void;
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
