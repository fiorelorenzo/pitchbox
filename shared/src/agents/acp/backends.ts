// shared/src/agents/acp/backends.ts

export type AcpBackendSlug =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'opencode'
  | 'qwen-code';

export interface BackendSpec {
  slug: AcpBackendSlug;
  displayName: string;
  // Absolute or PATH-resolved binary name.
  binary: string;
  // Args appended to the binary to start an ACP server over stdio.
  acpArgs: readonly string[];
  // Optional env vars passed through from process.env (in addition to opts.env).
  envPassthrough?: readonly string[];
  // Human notes - shown in Settings as install / auth hints.
  notes?: string;
}

// Exact acpArgs per backend are confirmed during implementation by reading
// each binary's --help. The shape stays the same; only the strings change.
export const ACP_BACKENDS: Record<AcpBackendSlug, BackendSpec> = {
  'claude-code': {
    slug: 'claude-code',
    displayName: 'Claude Code',
    binary: 'claude',
    acpArgs: ['--acp'],
    envPassthrough: ['ANTHROPIC_API_KEY'],
    notes: 'Install Anthropic Claude Code CLI and run `claude login`, or set ANTHROPIC_API_KEY.',
  },
  codex: {
    slug: 'codex',
    displayName: 'Codex',
    binary: 'codex',
    acpArgs: ['--acp'],
    envPassthrough: ['OPENAI_API_KEY'],
    notes: 'Install OpenAI Codex CLI and run `codex login`, or set OPENAI_API_KEY.',
  },
  gemini: {
    slug: 'gemini',
    displayName: 'Gemini CLI',
    binary: 'gemini',
    acpArgs: ['--acp'],
    envPassthrough: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    notes: 'Install Google Gemini CLI and authenticate, or set GEMINI_API_KEY.',
  },
  copilot: {
    slug: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binary: 'copilot',
    acpArgs: ['--acp'],
    notes: 'Install GitHub Copilot CLI and run `copilot auth login`.',
  },
  opencode: {
    slug: 'opencode',
    displayName: 'opencode',
    binary: 'opencode',
    acpArgs: ['acp'],
    notes: 'Install sst/opencode and configure a provider.',
  },
  'qwen-code': {
    slug: 'qwen-code',
    displayName: 'Qwen Code',
    binary: 'qwen',
    acpArgs: ['--acp'],
    notes: 'Install Qwen Code CLI and configure DashScope credentials.',
  },
};
