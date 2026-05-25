import { AcpRunner } from './acp/runner.js';
import { CloudRunnerStub } from './cloud.js';
import type { AgentRunner } from './base.js';
import type { AgentRunnerSlug } from './meta.js';
import type { RunnerConfig } from './config.js';

export { AGENT_RUNNER_META, type AgentRunnerSlug, type AgentRunnerMeta } from './meta.js';

const acp =
  (slug: Exclude<AgentRunnerSlug, 'cloud'>) =>
  (config?: RunnerConfig): AgentRunner =>
    new AcpRunner({ slug, config });

export const AGENT_RUNNERS: Record<AgentRunnerSlug, (config?: RunnerConfig) => AgentRunner> = {
  'claude-code': acp('claude-code'),
  codex: acp('codex'),
  gemini: acp('gemini'),
  copilot: acp('copilot'),
  opencode: acp('opencode'),
  'qwen-code': acp('qwen-code'),
  cloud: (config) => new CloudRunnerStub(config),
};

export function createAgentRunner(slug: string, config?: RunnerConfig): AgentRunner {
  if (slug in AGENT_RUNNERS) {
    return AGENT_RUNNERS[slug as AgentRunnerSlug](config);
  }
  throw new Error(`Unknown agent runner: ${slug}`);
}
