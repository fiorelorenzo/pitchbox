import { ClaudeCodeRunner } from './claude-code.js';
import type { AgentRunner } from './base.js';

export type AgentRunnerSlug = 'claude-code' | 'codex' | 'opencode';

export const AGENT_RUNNERS: Record<AgentRunnerSlug, () => AgentRunner> = {
  'claude-code': () => new ClaudeCodeRunner(),
  codex: () => {
    throw new Error('Codex runner not implemented yet — see shared/src/agents/codex.ts (future)');
  },
  opencode: () => {
    throw new Error(
      'OpenCode runner not implemented yet — see shared/src/agents/opencode.ts (future)',
    );
  },
};

export function createAgentRunner(slug: string): AgentRunner {
  if (slug in AGENT_RUNNERS) {
    return AGENT_RUNNERS[slug as AgentRunnerSlug]();
  }
  throw new Error(`Unknown agent runner: ${slug}`);
}

export type AgentRunnerMeta = {
  slug: AgentRunnerSlug;
  label: string;
  implemented: boolean;
};

export const AGENT_RUNNER_META: AgentRunnerMeta[] = [
  { slug: 'claude-code', label: 'Claude Code', implemented: true },
  { slug: 'codex', label: 'Codex', implemented: false },
  { slug: 'opencode', label: 'OpenCode', implemented: false },
];
