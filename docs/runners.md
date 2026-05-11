# Agent runners

Pitchbox's `AgentRunner` interface (`shared/src/agents/base.ts`) is the contract for any process that can execute a markdown playbook and stream events. Today only **claude-code** is implemented; `codex` and `opencode` exist as typed stubs.

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

## Adding a runner

1. Implement the `AgentRunner` interface in `shared/src/agents/<slug>.ts`.
2. Register it in `shared/src/agents/registry.ts` and add the meta in `shared/src/agents/meta.ts` (`implemented: true`).
3. Add a parser in `shared/src/runlog/parsers/<slug>.ts` if the runner's stream format isn't a passthrough.
4. Run the dashboard — detection picks the binary up automatically.
