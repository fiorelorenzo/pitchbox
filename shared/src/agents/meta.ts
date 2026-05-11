// Client-safe metadata for the agent runners. Importing this file does NOT pull
// the runner implementations (which depend on node:path / node:child_process and
// can't be bundled into the browser).

export type AgentRunnerSlug = 'claude-code' | 'codex' | 'opencode' | 'cloud';

export type AgentRunnerMeta = {
  slug: AgentRunnerSlug;
  label: string;
  implemented: boolean;
};

export const AGENT_RUNNER_META: AgentRunnerMeta[] = [
  { slug: 'claude-code', label: 'Claude Code', implemented: true },
  { slug: 'codex', label: 'Codex', implemented: false },
  { slug: 'opencode', label: 'OpenCode', implemented: false },
  { slug: 'cloud', label: 'Pitchbox Cloud', implemented: false },
];
