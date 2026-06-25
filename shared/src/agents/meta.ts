// Client-safe metadata for the agent runners. Importing this file does NOT pull
// the runner implementations (which depend on node:path / node:child_process and
// can't be bundled into the browser).

export type AgentRunnerSlug =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'opencode'
  | 'qwen-code'
  | 'cloud';

export type AgentRunnerMeta = {
  slug: AgentRunnerSlug;
  label: string;
  implemented: boolean;
};

export const AGENT_RUNNER_META: AgentRunnerMeta[] = [
  // Cloud is intentionally first: it is the primary, zero-setup runner, so the
  // dashboard's runner select (built from this order) always lists it first.
  { slug: 'cloud', label: 'Pitchbox Cloud', implemented: true },
  { slug: 'claude-code', label: 'Claude Code', implemented: true },
  { slug: 'codex', label: 'Codex', implemented: true },
  { slug: 'gemini', label: 'Gemini CLI', implemented: true },
  { slug: 'copilot', label: 'GitHub Copilot CLI', implemented: true },
  { slug: 'opencode', label: 'opencode', implemented: true },
  { slug: 'qwen-code', label: 'Qwen Code', implemented: true },
];

// Typed config schema so the dashboard can render per-runner fields
// generically without hardcoding inputs in components.
export type RunnerConfigField =
  | { key: string; kind: 'string'; label: string; placeholder?: string; description?: string }
  | {
      key: string;
      kind: 'select';
      label: string;
      options: string[];
      allowCustom?: boolean;
      description?: string;
    }
  | { key: string; kind: 'number'; label: string; min?: number; max?: number; description?: string }
  | { key: string; kind: 'boolean'; label: string; description?: string };

const CLAUDE_KNOWN_MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const CODEX_KNOWN_MODELS = ['gpt-5-codex'];
const OPENCODE_KNOWN_MODELS = ['opencode-default'];
const GEMINI_KNOWN_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];
const COPILOT_KNOWN_MODELS: string[] = [];
const QWEN_KNOWN_MODELS = ['qwen-coder-turbo', 'qwen-max'];

export const RUNNER_CONFIG_SCHEMA: Partial<Record<AgentRunnerSlug, RunnerConfigField[]>> = {
  'claude-code': [
    {
      key: 'model',
      kind: 'select',
      label: 'Model',
      options: CLAUDE_KNOWN_MODELS,
      allowCustom: true,
      description: 'Maps to `--model` on the `claude` CLI. Leave empty for the CLI default.',
    },
    {
      key: 'maxTurns',
      kind: 'number',
      label: 'Max turns',
      min: 1,
      max: 200,
      description: 'Hard cap on agent turns per run.',
    },
  ],
  codex: [
    {
      key: 'model',
      kind: 'select',
      label: 'Model',
      options: CODEX_KNOWN_MODELS,
      allowCustom: true,
      description: 'Maps to `--model` on the `codex` CLI. Defaults to `gpt-5-codex`.',
    },
  ],
  opencode: [
    {
      key: 'model',
      kind: 'select',
      label: 'Model',
      options: OPENCODE_KNOWN_MODELS,
      allowCustom: true,
      description: 'Maps to `--model` on the `opencode` CLI. Defaults to `opencode-default`.',
    },
  ],
  gemini: [
    {
      key: 'model',
      kind: 'select',
      label: 'Model',
      options: GEMINI_KNOWN_MODELS,
      allowCustom: true,
      description: 'Maps to the Gemini model identifier. Leave empty for the CLI default.',
    },
  ],
  copilot: [
    {
      key: 'model',
      kind: 'select',
      label: 'Model',
      options: COPILOT_KNOWN_MODELS,
      allowCustom: true,
      description: 'Copilot model identifier. Leave empty for the CLI default.',
    },
  ],
  'qwen-code': [
    {
      key: 'model',
      kind: 'select',
      label: 'Model',
      options: QWEN_KNOWN_MODELS,
      allowCustom: true,
      description: 'Maps to the Qwen model identifier. Leave empty for the CLI default.',
    },
  ],
};
