# Cloud runner

Status: IMPLEMENTED. The cloud runner is live end to end: the client adapter ships
in the private `cloud/adapter`, the runner service in the private `cloud/runner`
(a standalone repo, deployable as a Docker image with dev + prod overlays and an
optional Cloudflare Tunnel sidecar), the MCP relay is validated end to end, and
token + USD usage is metered on `session.done`. The runner owns the LLM
subscription and picks the model server-side (`RUNNER_MODEL`). This page keeps the
original design record below; the tags mark how firm each decision was: **[LOCKED]**
decided, **[PROPOSED]** recommended but open for change, **[OPEN]** needs a decision.

## Summary

The cloud runner lets Pitchbox execute an agent run without the user installing
or authenticating a coding-agent CLI locally. It is the default execution path
for the hosted product (Pitchbox Cloud) and an opt-in path for self-hosted
installs.

The core principle: **the runner is a stateless compute service. It owns the LLM
subscription and runs the agent loop, but it holds no user data and no database.
Data and credentials stay with the client** (the hosted per-tenant environment
today, the self-hoster's box later). This is the "cloud solo compute" model.

## Decisions

- **[LOCKED] Data boundary: cloud is compute-only.** Drafts, contacts, run
  history and Reddit credentials never live on the runner. Note: the _content_
  (Reddit posts, draft text, product description) necessarily transits the LLM
  in the cloud - that is unavoidable. What stays local is data at rest and
  credentials.
- **[LOCKED] Build order: hosted-first, but with the MCP boundary from day one.**
  One stateless runner serves both hosted and self-hosted identically; the only
  difference is who operates the client/MCP side. No v2 rearchitecture.
- **[LOCKED] Reuse the existing runner contract.** The cloud path implements the
  same `AgentRunner` interface (`shared/src/agents/base.ts`) and reuses the ACP
  event normalizer. The `cloud` slug and `CloudRunnerStub` are already wired
  (`shared/src/agents/cloud.ts`, registry, meta).

## Why moving the agent is not enough

The current `AcpRunner` (`shared/src/agents/acp/runner.ts`) declares
`clientCapabilities: { fs, terminal }` and `mcpServers: []` but implements **no
handlers** for `terminal/*` or `fs/*`. The agent (`@agentclientprotocol/claude-agent-acp`,
wrapping the Claude Agent SDK) therefore executes Bash **in-process**: the
playbook shells out to `pitchbox <cmd>`, which hits the local Postgres directly.
This works only because the agent is local.

If we relocate that same process to the cloud unchanged, the `pitchbox` commands
run in the cloud against a database that is not there. So "cloud solo compute"
requires routing every data operation back to the client. That is the MCP
boundary below.

## Spike result: VALIDATED

The load-bearing assumption is confirmed by an end-to-end spike against
`@agentclientprotocol/claude-agent-acp@0.45.1` (deps: `@agentclientprotocol/sdk@0.25.1`,
`@anthropic-ai/claude-agent-sdk@0.3.177`). Launched the adapter as an ACP server
over stdio, handed it an external stdio MCP server via `session/new` `mcpServers`,
and prompted the agent to call a tool returning a secret only that tool knew. The
agent connected to the external server, called the tool, the result flowed back,
and the secret appeared in the final message (cross-checked against the MCP
server's own out-of-band invocation log). So an agent in the cloud can be driven
entirely through a client-supplied MCP server. Concrete facts for the build:

- **`mcpServers` stdio entry schema** (ACP SDK `zMcpServerStdio`):
  `{ name, command, args, env }` where **`env` is required** (array of
  `{ name, value }`, may be empty). There are also `type: "http" | "sse" | "acp"`
  branches - the `http`/`sse` URL forms are what the network relay will use.
- **Tool naming**: MCP tools surface to the agent as `mcp__<server>__<tool>`.
- **Lazy loading**: tool schemas are fetched on demand (the agent runs a
  ToolSearch `select:mcp__...` before first use), not advertised up front.
- **Permission**: MCP tool calls trigger `session/request_permission`; the
  response shape this adapter accepts is
  `{ outcome: { outcome: "selected", optionId: "allow_always" } }`.
- **Side-finding (track separately)**: the repo's `AcpRunner` answers permission
  with `{ outcome: { type: "allow" } }`, which this adapter version does not
  recognise. Likely inert today because local runs use permission-bypass so the
  request never fires, but the cloud path (and any MCP tool use) must use the
  `selected` / `optionId` shape.

## Runner-service spike: VALIDATED

A second spike validated the runner service's load-bearing assumption: that the
agent can be driven through an MCP server reached over the **network**, not just
a local stdio subprocess. The real Pitchbox MCP server was exposed over
**Streamable HTTP** in one process; a separately-spawned `claude-agent-acp` was
pointed at it via `session/new` `mcpServers: [{ type: "http", url, headers: [] }]`
and ran the full reddit-scout playbook. The agent called `run_start`,
`reddit_scout`, `staging_candidates`, `drafts_create` and `run_finish` over HTTP,
the run finished `success`, and a real draft was written to the test DB.

This is the prerequisite for the relay: the runner can host an HTTP MCP endpoint
the agent talks to, and tunnel every MCP frame to the client. Facts for the build:

- ACP `mcpServers` **http** entry schema (ACP SDK `zMcpServerHttp`):
  `{ name, type: "http", url, headers }` where `headers` is a required array.
- The agent uses Streamable HTTP for `type: "http"` MCP servers
  (`StreamableHTTPServerTransport` on the server side works).
- The earlier permission side-finding is fixed in the local runner already
  (`selectPermissionOption`, commit history); the same shape is reused here.

The wire contract for the relay lives in OSS at
[`shared/src/agents/cloud/protocol.ts`](../shared/src/agents/cloud/protocol.ts)
(`@pitchbox/shared/agents/cloud/protocol`).

### Full relay: VALIDATED end to end

The transparent **MCP-over-WebSocket tunnel** is also validated. A prototype wired
the two halves together over a real WebSocket: a runner part (WS server) that
spawns the agent and hosts a raw `StreamableHTTPServerTransport` relay, and a
client part that runs the real Pitchbox MCP server bridged to the socket. Each
MCP frame the agent emits is tunnelled agent -> HTTP relay (runner) -> WS ->
client -> Pitchbox MCP server -> test DB, and back. Running reddit-scout through
this path, the agent's `run_start` / `reddit_scout` / `staging_candidates` /
`drafts_create` / `run_finish` calls **all executed client-side** against the
test DB, the run finished `success`, and a real draft was written. So the
compute/data split across the WebSocket works end to end - the load-bearing
proof for the whole runner service.

What is proven vs. what remains:

- **Proven**: agent + HTTP MCP; the bidirectional MCP-frame tunnel over a WS
  (with `relatedRequestId` correlation on the runner's StreamableHTTP `send`);
  client-side execution against the real DB; events flowing down.
- **Now shipped** (was "remaining"): the runner + client code moved into their
  homes (runner = standalone private repo at `cloud/runner`, dockerized; client =
  the `cloud/adapter`), both importing the OSS protocol contract; the runner runs
  the agent with its own LLM credentials and picks the model via `RUNNER_MODEL`;
  and usage + cost metering lands on `session.done`.
- **Still open (productionisation)**: the per-org WS auth handshake (a static
  bearer token is wired today) and reconnect/resume.

## Architecture

```
   RUNNER (private repo, public URL)              CLIENT (where the data lives)
   +------------------------------+                +---------------------------+
   | spawns the ACP agent (claude)|   WebSocket    | web + Postgres + creds    |
   | owns the LLM subscription    |<==============>| Reddit creds (encrypted)  |
   | local MCP shim (relay)       |  (client-init) | Pitchbox MCP server        |
   | NO data, NO DB - stateless   |                | runs/run_events persisted |
   +------------------------------+                +---------------------------+
        compute only                  MCP tool calls relayed down the WS
```

### Connection model [PROPOSED]

**The client initiates the connection** (outbound WebSocket to the runner). One
connection multiplexes three streams:

1. **Control**: open session (send playbook text + run/campaign context), cancel.
2. **Events down**: the agent's `session/update` notifications flow to the client,
   which normalizes them to `ParsedEvent`s and persists them (exactly as today).
3. **MCP relay**: the agent calls MCP tools against a **local MCP shim** the
   runner exposes to it; the shim forwards each tool call down the same WS to the
   client, which executes it against the local Pitchbox MCP server / DB and
   returns the result back up.

Client-initiated is what makes self-hosted work with no inbound firewall holes:
the self-hoster's box dials out; nothing is exposed publicly. The hosted case
uses the same path over the internal network.

The runner is therefore an **MCP proxy/relay** between a cloud-side agent and a
client-side executor, not just an event streamer.

## Components

### 1. Runner service (server-side, standalone private repo) [PROPOSED repo shape]

A deployable Pitchbox operates. Per session it:

- authenticates the inbound WS (per-org token), maps it to an org, enforces quota;
- spawns the ACP agent with the runner's own LLM credentials
  (`ANTHROPIC_API_KEY` / subscription);
- hands the agent an MCP server config pointing at its local relay shim;
- relays MCP tool calls down the client WS and streams `session/update` back;
- meters LLM usage for billing.

Holds no persistent user data. This is a separate deployable from the OSS repo,
not a submodule.

### 2. Pitchbox MCP server (client-side) [PROPOSED]

Wraps the existing CLI command surface as MCP tools. The logic already lives in
`cli/src/commands/`; the MCP server reuses those functions. Runs wherever the
data lives (co-located in the tenant env now, on the self-hoster's box later).
This is the single, auditable data-access boundary for remote agents - the
natural place to enforce blocklist/quota/org-scope.

The CLI command surface is small and maps almost 1:1 to MCP tools (every command
already speaks a `{ok, ...}` JSON envelope; many take stdin JSON):

| MCP tool                   | From CLI command           | Access                                                            |
| -------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `run.start`                | `run:start`                | read campaigns/projects/accounts/blocklist/contact_history        |
| `run.finish`               | `run:finish`               | write runs                                                        |
| `drafts.create`            | `drafts:create`            | read blocklist/contact_history, write drafts/draft_events, notify |
| `drafts.get`               | `drafts:get`               | read drafts                                                       |
| `drafts.regenerate`        | `drafts:regenerate`        | write draft_events/runs                                           |
| `reddit.scout`             | `reddit:scout`             | **Reddit API (creds)**, write staging_scout_candidates            |
| `hn.search`                | `hn:search`                | **HN Algolia API**, read-only                                     |
| `staging.candidates`       | `staging:candidates`       | read staging_scout_candidates                                     |
| `blocklist.check`          | `blocklist:check`          | read blocklist                                                    |
| `contact_history.check`    | `contact-history:check`    | read contact_history                                              |
| `project.extract.start`    | `project:extract:start`    | read runs/projects                                                |
| `project.extract.finish`   | `project:extract:finish`   | write projects/recommendations                                    |
| `project.insights.context` | `project:insights:context` | read projects/drafts/messages                                     |
| `project.insights`         | `project:insights`         | write project_insights                                            |
| `skill.generate.start`     | `skill:generate:start`     | read runs/campaigns/projects                                      |
| `skill.generate.finish`    | `skill:generate:finish`    | write campaigns/runs                                              |

All DB-touching and credential-using tools execute client-side, so data and
Reddit creds stay local.

### 3. Cloud adapter (client-side, OSS build via `cloud/` submodule) [LOCKED location]

The real implementation of the `cloud` `AgentRunner`, shipped from the private
`cloud/` submodule (the OSS build keeps the throwing stub). It:

- implements `run(opts): AgentRunHandle` like `AcpRunner`;
- opens the WS to the runner, sends the playbook + run/campaign context;
- services MCP relay requests by invoking the local Pitchbox MCP server;
- consumes `session/update`, reuses `event-normalizer.ts` to emit
  `onParsedEvents`, so `web/src/lib/server/runner.ts` persists events unchanged;
- maps `handle.cancel()` to a cancel control message.

## Run lifecycle and state

`runs` and `run_events` rows live in the **client** DB, exactly as today. The
runner is stateless; the adapter's `onParsedEvents` callback drives persistence
through the existing `dispatchRun` pipeline. Cancellation: client `cancel()` ->
WS control message -> runner `session/cancel` + agent teardown. Cost/usage from
the ACP `stop_reason` block flows back through the normalizer into the existing
`runs` cost columns.

## Auth, billing, LLM credentials [PROPOSED]

- **Auth**: per-org token (same spirit as the extension token in
  `app_config.extension_api_token`), minted by the cloud control plane. Self-hosters
  using the cloud runner get a token from their Pitchbox Cloud account.
- **LLM credentials**: the runner owns the Anthropic key/subscription - that is
  the value prop (no local agent CLI or API key needed). The agent in the cloud
  uses the runner's credentials.
- **Billing/quota**: metered per org on the runner from the ACP usage block;
  enforced before/while dispatching. Ties into the deferred "per-org runner-quota
  layer" already noted in `docs/auth.md`.

## Edition and repo strategy

- `PITCHBOX_EDITION=cloud` selects the cloud adapter (per `docs/auth.md`).
- Cloud adapter -> private `cloud/` submodule embedded optionally in the OSS build.
- Runner service -> **[LOCKED]** its own standalone private repo (a deployable),
  separate from the `cloud/` submodule. Rationale: the submodule is checked out
  into self-hosters' builds when they opt into the cloud edition; the service
  (billing, LLM subscription/keys, multi-tenant internals) must never land on a
  user machine. Separation also decouples deploy cadence and shrinks the secret
  blast radius. The shared cost - the WS/relay + MCP protocol message shapes -
  is solved by putting the **protocol contract in the OSS repo** (a small module
  under `shared/`); it is a contract, not a secret, so adapter and service import
  identical shapes without sharing implementation.

## Playbook migration

Playbooks move from `pitchbox <cmd>` shell-outs to MCP tool calls. Per the
inventory, the affected playbooks and their command sets are bounded:
`reddit-scout`, `reddit-commenter`, `reddit-poster`, `hn-commenter`, `hn-poster`,
`project-extractor`, `project-insighter`, `campaign-skill-generator`,
`reply-drafter`. This is the largest enabling piece of work and is required for
the compute-only model.

**[LOCKED] One execution model everywhere.** Local runners (claude-code etc.)
also switch to the Pitchbox MCP server: there is no CLI-shell-out path retained
for local. For a local run the `AcpRunner` spawns/points the agent at the
MCP server over stdio via `session/new` `mcpServers`; for a cloud run the same
server is reached over the network relay. Consequence: the **local runner becomes
the first consumer of the MCP server**, so the whole boundary is built and
validated locally (no cloud infra) before any service exists. This touches the
working local path, so migrate carefully: keep the CLI alive during the
transition, move one playbook at a time, and keep tests green at each step.

## Phased build order [PROPOSED]

1. **Spike: DONE (validated).** Confirmed `@agentclientprotocol/claude-agent-acp`
   forwards `session/new` `mcpServers` to the SDK and routes tool calls to an
   external MCP server end to end. See "Spike result" above.
2. **Pitchbox MCP server**: wrap the CLI command surface as MCP tools, reusing
   `cli/src/commands/` logic. Drive a local runner against it end to end (no
   cloud yet) to prove the boundary.
3. **Migrate playbooks** to MCP tools (incrementally, behind the MCP-capable path).
4. **Runner service** (private repo): WS transport, agent spawn, MCP relay shim,
   auth, usage metering.
5. **Cloud adapter** (`cloud/` submodule): WS client, MCP relay servicing, event
   normalization, cancel.
6. **Hosted wiring + billing/quota**, then open the opt-in path for self-hosted.

## Open questions

- **[RESOLVED]** Does the chosen ACP backend honor external `mcpServers`? Yes -
  validated end to end (see "Spike result"). The compute-only model is feasible.
- **[RESOLVED]** Runner service repo shape: standalone private repo, protocol
  contract in OSS `shared/` (see "Edition and repo strategy").
- **[RESOLVED]** Local runners on MCP too: yes, one execution model everywhere,
  no CLI-shell-out path retained (see "Playbook migration").
- **[OPEN]** WS reconnection/resume semantics for long runs and flaky self-hosted
  links.
- **[OPEN]** Token/billing model details (per-org issuance, rotation, quota units).
