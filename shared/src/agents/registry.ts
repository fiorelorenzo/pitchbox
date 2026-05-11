import { ClaudeCodeRunner } from './claude-code.js';
import { CloudRunnerStub } from './cloud.js';
import type { AgentRunner } from './base.js';
import type { AgentRunnerSlug } from './meta.js';
import type { RunnerConfig } from './config.js';

export { AGENT_RUNNER_META, type AgentRunnerSlug, type AgentRunnerMeta } from './meta.js';

export const AGENT_RUNNERS: Record<AgentRunnerSlug, (config?: RunnerConfig) => AgentRunner> = {
  'claude-code': (config) => new ClaudeCodeRunner({ config }),
  codex: () => {
    throw new Error('Codex runner not implemented yet — see shared/src/agents/codex.ts (future)');
  },
  opencode: () => {
    throw new Error(
      'OpenCode runner not implemented yet — see shared/src/agents/opencode.ts (future)',
    );
  },
  cloud: (config) => new CloudRunnerStub(config),
};

export function createAgentRunner(slug: string, config?: RunnerConfig): AgentRunner {
  if (slug in AGENT_RUNNERS) {
    return AGENT_RUNNERS[slug as AgentRunnerSlug](config);
  }
  throw new Error(`Unknown agent runner: ${slug}`);
}
