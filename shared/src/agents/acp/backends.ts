// shared/src/agents/acp/backends.ts

import type { AgentRunnerSlug } from '../meta.js';

export type AcpBackendSlug = Exclude<AgentRunnerSlug, 'cloud'>;

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
    // Claude Code's `claude` CLI does NOT speak ACP directly. The official
    // adapter `@agentclientprotocol/claude-agent-acp` (also used by Zed) wraps
    // the Claude Agent SDK and exposes it over ACP/JSON-RPC. We launch it via
    // `npx -y` so users don't need a separate global install; auth + model
    // selection still come from the underlying `claude` CLI's local state.
    binary: 'npx',
    acpArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
    envPassthrough: ['ANTHROPIC_API_KEY'],
    notes:
      'Requires the `claude` CLI installed and authenticated (`claude login`), or set ANTHROPIC_API_KEY. The ACP adapter `@agentclientprotocol/claude-agent-acp` is fetched on demand via npx (cached after first run).',
  },
  codex: {
    slug: 'codex',
    displayName: 'Codex',
    // OpenAI's `codex` CLI does not expose an ACP server mode. The adapter
    // `@zed-industries/codex-acp` (same project Zed bundles internally) wraps
    // it and speaks ACP/JSON-RPC. Auth still flows through the local `codex`
    // CLI state (`codex login`) or OPENAI_API_KEY.
    binary: 'npx',
    acpArgs: ['-y', '@zed-industries/codex-acp'],
    envPassthrough: ['OPENAI_API_KEY'],
    notes:
      'Requires the `codex` CLI installed and authenticated (`codex login`), or set OPENAI_API_KEY. The ACP adapter `@zed-industries/codex-acp` is fetched on demand via npx.',
  },
  gemini: {
    slug: 'gemini',
    displayName: 'Gemini CLI',
    // Native ACP support: `gemini --acp` (per google-gemini/gemini-cli docs).
    binary: 'gemini',
    acpArgs: ['--acp'],
    envPassthrough: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    notes:
      'Install `@google/gemini-cli` and authenticate, or set GEMINI_API_KEY / GOOGLE_API_KEY. ACP is native via `gemini --acp`.',
  },
  copilot: {
    slug: 'copilot',
    displayName: 'GitHub Copilot CLI',
    // Native ACP support since the public-preview ACP rollout: `copilot --acp`.
    binary: 'copilot',
    acpArgs: ['--acp'],
    notes:
      'Install GitHub Copilot CLI and run `copilot auth login`. ACP is native via `copilot --acp` (public preview).',
  },
  opencode: {
    slug: 'opencode',
    displayName: 'opencode',
    // Native ACP support via the `acp` sub-command.
    binary: 'opencode',
    acpArgs: ['acp'],
    notes: 'Install `opencode-ai` and configure a provider. ACP is native via `opencode acp`.',
  },
  'qwen-code': {
    slug: 'qwen-code',
    displayName: 'Qwen Code',
    // Native ACP support: `qwen --acp` (replaces the deprecated
    // `--experimental-acp` flag).
    binary: 'qwen',
    acpArgs: ['--acp'],
    notes:
      'Install Qwen Code CLI and configure DashScope credentials. ACP is native via `qwen --acp`.',
  },
};
