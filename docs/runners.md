# Agent runners

Pitchbox's `AgentRunner` interface (`shared/src/agents/base.ts`) is the contract for any process that can execute a markdown playbook and stream events. Today **claude-code**, **codex**, and **opencode** are implemented; **cloud** remains a stub.

## CLI invocation

| Runner      | Binary     | Invocation                                                   | Default model      |
| ----------- | ---------- | ------------------------------------------------------------ | ------------------ |
| claude-code | `claude`   | `claude -p <prompt> --output-format stream-json [--model M]` | CLI default        |
| codex       | `codex`    | `codex exec --json <prompt> [--model M]`                     | `gpt-5-codex`      |
| opencode    | `opencode` | `opencode run --json <prompt> [--model M]`                   | `opencode-default` |

The `codex` and `opencode` flag shapes are best-effort assumptions based on the published CLIs and may drift across versions; the parsers (`shared/src/runlog/parsers/codex.ts`, `shared/src/runlog/parsers/opencode.ts`) accept several event shapes defensively and fall back to an `unknown` event so the run timeline always records the raw line.

## Detection

On boot, Pitchbox probes each registered runner's CLI by running `<binary> --version`. Results are cached for the process lifetime and surfaced in **Settings → Status → Agent runners** with a **Re-detect** button. The campaign-creation form disables runners that aren't installed, and `POST /api/run` refuses to dispatch a campaign whose runner is unavailable.

```http
GET /api/runners
POST /api/runners        # clears the cache and re-probes
```

## Configuration

Per-runner configuration (`model`, `maxTurns`, `extraArgs`) lives in `app_config.runner_configs.<slug>`. Edit inline under each runner in Settings, or:

```http
GET /api/settings/runner-config
PUT /api/settings/runner-config       # { slug, config }
```

The dispatch path loads the config via `loadRunnerConfig()` and passes it to `createAgentRunner(slug, config)`. For `claude-code`, that translates into `--model`, `--max-turns`, and any extra flags appended after `-p / --output-format stream-json`.

## Failure taxonomy

Whenever a run transitions to `failed`, Pitchbox classifies the failure into one of six structured reasons and writes it to `runs.failure_reason`. The classifier is `classifyFailure(events, exitCode)` in [`shared/src/runlog/classify-failure.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/shared/src/runlog/classify-failure.ts) - a pure TypeScript function so the taxonomy can grow without a DB migration. The campaigns detail page surfaces the value as a chip on each failed run and lets you filter the run history by reason.

| Reason            | Heuristic                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `runner_missing`  | Exit non-zero with `command not found` / `ENOENT`                                                       |
| `auth_expired`    | Any event mentioning `auth`, `401`, `403`, `token expired`                                              |
| `quota_exhausted` | Any event mentioning `quota` or `rate limit`                                                            |
| `playbook_error`  | Exit non-zero with a Node-style or Python stack trace                                                   |
| `network`         | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `getaddrinfo`, `fetch failed`, `socket hang up` |
| `unknown`         | Default - nothing else matched                                                                          |

The classifier order matters: `runner_missing` wins over `playbook_error` because an `ENOENT` will otherwise look like a generic stack trace. Order beyond that is stable and covered by `shared/tests/runlog/classify-failure.test.ts`.

## Cost tracking

Each `runs` row captures the runner's reported token usage and USD cost. For `claude-code`, the parser reads the `usage` block and optional `total_cost_usd` from the terminal `result` event and writes `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, and `cost_usd`. When the runner reports `total_cost_usd`, that value is trusted as-is; otherwise the cost is computed locally from the token columns using Claude Sonnet 4.6 list pricing (`$3 / $15` per 1M input/output, `$0.30 / $3.75` per 1M cache read/creation - see [`shared/src/runlog/usage.ts`](https://github.com/fiorelorenzo/pitchbox/tree/development/shared/src/runlog/usage.ts)). Aggregates surface on the Home page (24h / 7d spend) and in the per-run "Cost" column on the campaign detail page.

## Adding a runner

1. Implement the `AgentRunner` interface in `shared/src/agents/<slug>.ts`.
2. Register it in `shared/src/agents/registry.ts` and add the meta in `shared/src/agents/meta.ts` (`implemented: true`).
3. Add a parser in `shared/src/runlog/parsers/<slug>.ts` if the runner's stream format isn't a passthrough.
4. Run the dashboard - detection picks the binary up automatically.
