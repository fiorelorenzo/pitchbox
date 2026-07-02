# Agent runners

Pitchbox's `AgentRunner` interface (`shared/src/agents/base.ts`) is the contract for any process that can execute a markdown playbook and stream events. Local runners go through a single `AcpRunner` (`shared/src/agents/acp/runner.ts`) built on top of the open [Agent Client Protocol](https://agentclientprotocol.com) (see Zed's reference adapter at [zed-industries/claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)); adding a new ACP-compatible backend is a small data change, no new runner class. The one exception is the managed **Pitchbox Cloud** runner (below), which dispatches to a remote runner service instead of spawning a local CLI.

## Pitchbox Cloud (default)

`cloud` (**Pitchbox Cloud**) is the first, default-selected runner and needs no local agent CLI. Instead of spawning a CLI on your box, it dispatches the run to a managed runner service that owns the LLM subscription, runs the agent on its own compute, and picks the model server-side (the runner's `RUNNER_MODEL`, not a per-campaign setting). The service is **compute-only**: it relays every MCP frame back over a WebSocket to the client, which runs the Pitchbox MCP server locally, so your data and credentials never leave your box. Token + USD usage is metered exactly like the local runners and written to the `runs` row. Full design, wire protocol, and self-hosting (the runner ships as a Docker image): [Cloud runner](/cloud-runner).

## Supported backends

Four of the six backends speak ACP natively (a CLI flag or sub-command on the agent's own binary). Two of them, Claude Code and Codex, do NOT expose an ACP server mode on their primary CLI; for those, Pitchbox launches a thin adapter package via `npx` that wraps the agent's SDK and re-exposes it as an ACP server. Authentication still flows through each agent's own local state (e.g. `claude login`), so no extra auth step is required.

| Slug          | Display name       | How Pitchbox launches it                       | Install / auth hint                                                                                                                                |
| ------------- | ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | Claude Code        | `npx -y @agentclientprotocol/claude-agent-acp` | Install Anthropic Claude Code CLI and run `claude login`, or set `ANTHROPIC_API_KEY`. Adapter is fetched on demand and cached after the first run. |
| `codex`       | Codex              | `npx -y @zed-industries/codex-acp`             | Install OpenAI Codex CLI and run `codex login`, or set `OPENAI_API_KEY`. Adapter is fetched on demand and cached after the first run.              |
| `gemini`      | Gemini CLI         | `gemini --acp`                                 | Install `@google/gemini-cli` and authenticate, or set `GEMINI_API_KEY` / `GOOGLE_API_KEY`. ACP is native.                                          |
| `copilot`     | GitHub Copilot CLI | `copilot --acp`                                | Install GitHub Copilot CLI and run `copilot auth login`. ACP is native (public preview).                                                           |
| `opencode`    | opencode           | `opencode acp`                                 | Install `opencode-ai` and configure a provider. ACP is native via the `acp` sub-command.                                                           |
| `qwen-code`   | Qwen Code          | `qwen --acp`                                   | Install Qwen Code CLI and configure DashScope credentials. ACP is native (replaces the deprecated `--experimental-acp` flag).                      |

Backend specs (binary name, ACP args, env passthrough, install notes) live as data in `shared/src/agents/acp/backends.ts` and are surfaced verbatim in **Settings → Status → Agent runners**.

## How it works

`AcpRunner` spawns the backend binary in ACP mode, frames JSON-RPC over stdio, and listens for `session/update` notifications. The event normalizer (`shared/src/agents/acp/event-normalizer.ts`) converts those notifications into `ParsedEvent`s consumed by the runlog UI. Permission requests from the backend are auto-allowed by default through `AutoAllowPolicy` (`shared/src/agents/acp/permission.ts`), matching the previous `--dangerously-skip-permissions` behaviour.

## Detection

On boot, Pitchbox probes each registered runner's CLI by running `<binary> --version`. Results are cached for the process lifetime and surfaced in **Settings → Status → Agent runners** with a **Re-detect** button. The campaign-creation form disables runners that aren't installed, and `POST /api/run` refuses to dispatch a campaign whose runner is unavailable.

```http
GET /api/runners
POST /api/runners        # clears the cache and re-probes
```

## Configuration

Per-runner configuration lives in `app_config.runner_configs.<slug>`. Edit inline under each runner in Settings, or:

```http
GET /api/settings/runner-config
PUT /api/settings/runner-config       # { slug, config }
```

The dispatch path loads the config via `loadRunnerConfig()` and passes it to `createAgentRunner(slug, config)`. Per-backend config maps to that backend's documented flags/env vars; details live in `RUNNER_CONFIG_SCHEMA` (`shared/src/agents/meta.ts`). For `claude-code`, the configured `model` (and `maxTurns`) reach the backend through the ACP session's `_meta.claudeCode.options` (`buildClaudeCodeMeta` in `acp/runner.ts`). The `cloud` runner has no client-side model config: its model is chosen by the runner service.

## Failure taxonomy

Whenever a run transitions to `failed`, Pitchbox classifies the failure into one of the structured reasons below and writes it to `runs.failure_reason`. The classifier is `classifyFailure(events, exitCode)` in [`shared/src/runlog/classify-failure.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/shared/src/runlog/classify-failure.ts), a pure TypeScript function so the taxonomy can grow without a DB migration. The campaigns detail page surfaces the value as a chip on each failed run and lets you filter the run history by reason.

| Reason            | Heuristic                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `runner_missing`  | Exit non-zero with `command not found` / `ENOENT`                                                       |
| `auth_expired`    | Any event mentioning `auth`, `401`, `403`, `token expired`                                              |
| `quota_exhausted` | Any event mentioning `quota` or `rate limit`                                                            |
| `playbook_error`  | Exit non-zero with a Node-style or Python stack trace                                                   |
| `network`         | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `getaddrinfo`, `fetch failed`, `socket hang up` |
| `agent_crashed`   | ACP backend subprocess exited unexpectedly without a `stop_reason`                                      |
| `agent_timeout`   | ACP backend did not respond within `opts.timeoutMs`                                                     |
| `unknown`         | Default, nothing else matched                                                                           |

The classifier order matters: `runner_missing` wins over `playbook_error` because an `ENOENT` will otherwise look like a generic stack trace. Order beyond that is stable and covered by `shared/tests/runlog/classify-failure.test.ts`.

## Cost tracking

Each `runs` row captures the runner's reported token usage and USD cost, for both the local ACP runners and the cloud runner (the runner service returns the same usage split on `session.done`). Cost extraction happens in the ACP event normalizer (`shared/src/agents/acp/event-normalizer.ts`) when a `stop_reason` event arrives with a usage block: it writes `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, and `cost_usd`. When the backend reports `total_cost_usd`, that value is trusted as-is; otherwise the cost is computed locally from the token columns using Claude Sonnet 4.6 list pricing (`$3 / $15` per 1M input/output, `$0.30 / $3.75` per 1M cache read/creation, see [`shared/src/runlog/usage.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/shared/src/runlog/usage.ts)). Aggregates surface on the Home page (24h / 7d spend) and in the per-run "Cost" column on the campaign detail page.

## Adding a backend

1. Add an entry to `ACP_BACKENDS` in `shared/src/agents/acp/backends.ts` with slug, binary, ACP flag, and install hint.
2. Add the slug to `AgentRunnerSlug` and `AGENT_RUNNER_META` in `shared/src/agents/meta.ts`.
3. Add the slug to `AGENT_RUNNERS` in `shared/src/agents/registry.ts` (one line wrapping `AcpRunner`).
4. Optional: add a config schema entry in `RUNNER_CONFIG_SCHEMA` (model list etc).

No new files, no parser, no runner subclass.
