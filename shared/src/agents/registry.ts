import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex.js';
import { OpenCodeRunner } from './opencode.js';
import { CloudRunnerStub } from './cloud.js';
import type { AgentRunner } from './base.js';
import type { AgentRunnerSlug } from './meta.js';
import type { RunnerConfig } from './config.js';

export { AGENT_RUNNER_META, type AgentRunnerSlug, type AgentRunnerMeta } from './meta.js';

export const AGENT_RUNNERS: Record<AgentRunnerSlug, (config?: RunnerConfig) => AgentRunner> = {
  'claude-code': (config) => new ClaudeCodeRunner({ config }),
  codex: (config) => new CodexRunner({ config }),
  opencode: (config) => new OpenCodeRunner({ config }),
  cloud: (config) => new CloudRunnerStub(config),
};

export function createAgentRunner(slug: string, config?: RunnerConfig): AgentRunner {
  if (slug in AGENT_RUNNERS) {
    return AGENT_RUNNERS[slug as AgentRunnerSlug](config);
  }
  throw new Error(`Unknown agent runner: ${slug}`);
}
