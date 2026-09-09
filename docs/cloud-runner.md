# Cloud runner

Status: IMPLEMENTED. The `cloud` runner is an ordinary `AgentRunner`
(`shared/src/agents/sdk/runner.ts`, the `SdkRunner` class) that runs the whole
agent loop, model calls and MCP tool calls both, inside the web/daemon
process. Its only remote is the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).
There is no separate compute service, no WebSocket relay, and no per-org JWT.
An earlier design built and partly shipped exactly that (a standalone runner
service reached over a WebSocket relay) before being replaced wholesale; see
"Historical design record" at the bottom for why, and #415/#416/#420 for the
decision and the cutover that removed it.

## Summary

Picking `cloud` as a project or campaign's runner (the default, and the only
option in the `cloud` edition - see "Environment variables" below) dispatches
through the same `dispatchRun` (`web/src/lib/server/runner.ts`) every local
ACP backend goes through. `createAgentRunner('cloud', config)` returns a
`SdkRunner`, whose `run()`:

1. reads `AI_GATEWAY_API_KEY` and fails the run immediately if it is unset,
   rather than letting the first model call surface an opaque provider error;
2. resolves a Gateway model id (see "How a model is chosen" below) and opens
   it via `@ai-sdk/gateway`'s `createGateway({ apiKey })`;
3. for a campaign run, hands the playbook body to `streamText` as the
   **system** prompt and one line naming the run/campaign as the **user**
   turn; for the in-page assistant's suggestion endpoint, which has no
   playbook, `opts.prompt` is the user turn directly and no MCP tools are
   attached (`attachMcp: false`) - there is nothing for a suggestion to write,
   and a tool loop is exactly what a real-time path with a human waiting
   cannot afford;
4. bounds the loop with `stopWhen(stepCountIs(12))` (`DEFAULT_STEP_CEILING`) -
   fixed today; a playbook that genuinely needs more steps would need a
   per-scenario override, and none is wired yet (see "Open questions");
5. streams `fullStream` and normalizes each part
   (`shared/src/agents/sdk/event-normalizer.ts`) into the same `ParsedEvent`
   shape the ACP normalizer produces, so the run view, the SSE feed and the
   dedup logic in `dispatchRun` don't know which runner ran.

Measured end to end (#415's probe, still representative of the shape):
`playbooks/hn-commenter.md` to completion on `google/gemini-3.1-flash-lite`
against a real campaign row - seven tool calls (`run_start`, four
`hn_search`, `drafts_create`, `run_finish`), 15.4s wall, 42,767 input tokens
(18,065 from cache), 576 output tokens, a real draft written, run row
`success`.

Cancellation and timeout both work in-process. One finding worth carrying
forward: an aborted `streamText` does **not** throw - it ends the stream
cleanly with `finishReason: 'other'`. A runner that read "the stream ended"
as success would record a cancelled or timed-out run as completed, so the
outcome is decided by which `AbortSignal` fired (tracked explicitly by the
runner as `outcome: 'cancel' | 'timeout' | null`), never by the absence of a
throw. The v0.10.14 completion contract (an agent turn that never called the
finish tool is a failure) is the second net under that.

## Where the data boundary sits, and why it did not move

The Pitchbox MCP server (`createPitchboxMcpServer`, `cli/src/mcp/server.ts`)
still runs **client-side** - in the earlier design that meant a separate
process the runner tunneled tool calls to over a relay; today it means the
same process as the model loop, connected over an in-memory transport
(`InMemoryTransport.createLinkedPair()`, wired up in
`shared/src/agents/sdk/tools.ts`'s `createPitchboxToolSet`) instead of a
network hop. `await mcp.tools()` hands `streamText` the resulting tool set
directly.

The boundary is MCP, not "which machine the compute runs on", and that is
deliberate: org scoping and ownership checks live **inside the tool
handlers**, and the run/campaign/project ids a tool call operates on are
bound by the session rather than chosen by the agent. Keeping MCP as the
contract means that binding is exactly one thing to get right regardless of
which runner executes it - a local ACP backend over stdio, or the SDK runner
over an in-process pipe - rather than a second surface over the same
handlers that could drift and let one tenant read another's rows. Reaching
the tools through MCP also means the SDK runner sees the identical 26-tool
surface the ACP path does, byte for byte, because it is the same
registration code (`cli/src/mcp/tool-set.ts`, #417); a tool that fails returns its
error to the model instead of killing the loop, exactly as it always did.

`bin/pitchbox-mcp`'s stdio entrypoint stays, for the local ACP backends and
for anyone driving the tools by hand - only the network relay a standalone
runner service would have needed is gone.

## How a model is chosen, per function

Which model runs a given job is an instance-level admin setting (#411), not
a code constant or an environment variable. `shared/src/ai/model-functions.ts`
names five functions a model call actually happens for:

| Function           | What it does                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `campaign_draft`   | A campaign run drafting outreach - also a reply draft and a regenerated draft, the same job with a narrower input |
| `assist_suggest`   | The in-page companion suggesting a comment or post while someone waits                                            |
| `project_extract`  | Reading a repo/folder/website and writing what a project is                                                       |
| `project_insights` | Turning what a project knows into notes later drafting prompts carry                                              |
| `skill_generate`   | Writing a campaign profile from a project and a scenario                                                          |

Each has a coded default - `google/gemini-3.1-flash-lite` for all five today,
one cheap fast model everywhere so the expensive choice isn't made for every
tenant before anyone has measured whether a job needs it. An instance admin
can override any of them at **Settings → Admin → Models**
(`/settings/admin/models`), picking from the Gateway's own model catalogue
(`shared/src/ai/gateway-catalogue.ts` - 345+ models with per-token pricing at
last count, cached 10 minutes, so the picker offers what can actually be
called rather than a free-text box where a typo fails every run for every
tenant) or typing an id by hand when no Gateway key is configured to fetch
one. Saved overrides live in `app_config.model_functions` and are cached
in-process for 30 seconds, invalidated immediately on save.

Which function a playbook belongs to (`modelFunctionForPlaybook`): the
project extractor, insighter and skill generator each get their own
function; every commenter, poster, scout, the reply drafter and the draft
regenerator all share `campaign_draft`, since they are the same job with a
different input.

Wiring: `dispatchRun` (`web/src/lib/server/runner.ts`) calls
`resolveModelForRun(db, { runnerSlug, playbookSlug })` before constructing
the runner; the suggestion endpoint (`web/src/lib/server/suggest.ts`) calls
`resolveFunctionModel(db, 'assist_suggest')` directly, since it has no
playbook to look up. Both are gated by `runnerTakesGatewayModel(slug)`,
true only for `'cloud'` - an ACP backend's `model` option is that CLI's own
vocabulary (`sonnet`, `opus`), so a Gateway id never reaches it. An explicit
per-runner pin at **Settings → Runners** (`RunnerConfig.model`) always wins
over the function default: resolution only fills in a model when that field
is empty, so an operator who pinned one meant it.

## How cost and quota work

**Cost (#418).** A Gateway run can be any model, and cached input has to be
priced separately from fresh input, unlike the old hand-maintained
Claude-only price table (`shared/src/runlog/usage.ts`). The SDK event
normalizer (`buildSdkUsage`/`computeSdkCostUsd` in
`shared/src/agents/sdk/event-normalizer.ts`) resolves per-token pricing from
the Gateway's own model catalogue (`gateway.getAvailableModels()`, cached 5
minutes in the runner) for the run's actual model, and prices the token
split itself when the Gateway doesn't self-report a total cost. The result
lands in the same `runs.cost_usd` / `input_tokens` / `output_tokens` /
`cache_read_tokens` / `cache_creation_tokens` columns every other runner
writes to, so nothing downstream - the campaigns detail page, analytics -
needs to know which runner produced a given run.

**Quota (#419).** `shared/src/org-quota.ts`'s `getOrgQuotaSnapshot(db, orgId)`
computes `{ remainingUsd, concurrencyCap }` from two nullable `organizations`
columns an admin sets at **Settings → Organization**
(`monthly_run_budget_usd`, `max_concurrent_runs`, null meaning unlimited) and
the org's month-to-date `runs.cost_usd`. No new table and no migration: both
figures are a read of data the dispatch pipeline already writes.
`dispatchRun` calls this before constructing a `cloud` runner and refuses the
run outright, as a normal failed run with a clear over-budget message, when
`remainingUsd` is not null and `<= 0`. Because a run can still cross its
budget mid-flight, `SdkRunner` also checks its own running cost against the
snapshot after every step and aborts (a new outcome, `'quota'`) if a single
run's own spend crosses the line - normalized to the `quota_exhausted`
failure reason `shared/src/runlog/classify-failure.ts` already recognizes via
its existing `QUOTA_PATTERNS`, with no classifier change needed.

**Concurrency (#485).** `concurrencyCap` is part of the snapshot above, and
`assertOrgConcurrencyAdmitted` (`shared/src/org-quota.ts`) enforces it: after
`dispatchRun` inserts a run's `status: 'running'` row, it takes an
org-scoped `pg_advisory_xact_lock`, ranks every currently-`running` row for
the org by insertion order, and refuses this one if its rank exceeds
`max_concurrent_runs` - a message that says "concurrency limit", never
"quota", so `classifyFailure` tags it `concurrency_exhausted` rather than
`quota_exhausted`. The earlier runner-service design enforced the same idea
from an in-memory per-org session count at WebSocket admission (CLD-P5, see
"Historical design record"); that mechanism left with the runner service,
and this replaces it with a Postgres-backed check that survives the process
restarting mid-run.

## Environment variables a cloud deployment needs

| Variable                 | Required                          | What it does                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`     | Yes                               | The only remote credential. `SdkRunner` fails every run immediately if unset.                                                                                                                                                                                                             |
| `PITCHBOX_EDITION=cloud` | Yes for the hosted/Docker edition | Selects the cloud edition (`shared/src/edition.ts`): only the `cloud` runner is dispatchable (`isRunnerAllowed`), the project/campaign runner picker offers just Pitchbox Cloud, and `/settings/admin` (instance-wide config, including the model-function overrides above) is reachable. |

Nothing else. In particular, everything the earlier runner-service design
needed is gone (#420) along with the service itself, not merely unused:
`PITCHBOX_RUNNER_URL`, `RUNNER_JWT_PRIVATE_KEY` / `RUNNER_JWT_PUBLIC_KEY` /
`RUNNER_JWT_TTL_SECONDS`, `PITCHBOX_RUNNER_TOKEN` / `RUNNER_TOKEN`,
`RUNNER_MODEL`, `RUNNER_HOST`, `RUNNER_DRAIN_TIMEOUT_MS`, and
`PITCHBOX_RUNNER_BACKEND` - no separate process to authenticate to, drain, or
point a server-side model override at. Model selection is the per-function
admin setting above, not an environment variable; cost and quota read
`organizations` columns, not the environment either.

The `cloud/runner` and `cloud/adapter` git submodules (`.gitmodules`) are
still registered at their existing pointers but are not wired into the build
or deploy path at all - no Vite alias, no Dockerfile step, no compose
service imports either one. A fresh worktree does not need `git submodule
update --init` for the cloud edition to work.

## Open questions

- ~~**Concurrency cap is unenforced.**~~ Closed by #485:
  `assertOrgConcurrencyAdmitted` now enforces `max_concurrent_runs` on every
  cloud-runner dispatch. See "How cost and quota work" above.
- **[OPEN] No per-scenario step ceiling override.** `DEFAULT_STEP_CEILING`
  (12) is a single constant for every playbook. A playbook that genuinely
  needs more steps has no way to ask for them short of raising the shared
  default for everyone.

## Historical design record

Before the SDK runner, the cloud runner was designed and partly built as a
standalone compute service: the client would open a WebSocket to it, the
service would spawn a coding-agent CLI on its own LLM credentials, and every
MCP tool call the agent made would tunnel back over that same socket to a
Pitchbox MCP server running on the client - compute and data on two
different machines, connected by a relay. Three spikes validated the
approach end to end (an agent driven entirely through a client-supplied MCP
server, the same thing over the network, and the full tunnel through a real
WebSocket, each writing a real draft to a real database), and a
production-hardening pass (`docs/cloud-runner-productionization-design.md`)
shipped per-org JWT auth, resumable sessions, per-org quota admission,
graceful drain on redeploy, and structured observability on top of it.

None of that runs today. #415 found that the reason for all of it - a model
reachable only through a CLI that needed a filesystem, a permission prompt
and a personal credential - was gone once the model became a plain Gateway
HTTPS call: the thing that had to be remote became the only thing that is
remote, and the client already held both halves the relay existed to
reunite. #420 deleted the wire contract (`shared/src/agents/cloud/protocol.ts`),
the JWT signing/verifying code, and the old `cloud.ts`
runner/lazy-adapter-loader outright, along with every environment variable
and compose service the runner process needed - not trimmed, removed, since
none of it has a caller left.

The one decision that survived unchanged is the one still load-bearing
today: **MCP as the data-access boundary**, kept as the contract and dropped
only as a network requirement. Read "Where the data boundary sits, and why
it did not move" above for the current shape; the WebSocket relay, the JWT
claims, the drain state machine and the Prometheus metrics described in the
productionization design doc are historical record only, describing
infrastructure that has since been deleted, not anything still running.
