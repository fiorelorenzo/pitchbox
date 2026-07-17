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
- **Productionisation (`docs/cloud-runner-productionization-design.md`) is
  fully shipped**: the per-org WS auth handshake (section 1, CLD-P1),
  resumable sessions (section 3, CLD-P3), per-org quota enforcement (section
  5, CLD-P5) - see "Auth, billing, LLM credentials" below - drain on cutover
  (section 4, CLD-P4) - see "Drain on cutover" below - and observability
  (section 6, CLD-P6) - see "Observability" below.

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

## Auth, billing, LLM credentials

- **Auth [IMPLEMENTED, CLD-P1]**: a short-lived, per-org JWT (EdDSA/Ed25519),
  minted client/control-plane side at dispatch time and carrying the
  dispatching run's `org_id`. The web signs it with `RUNNER_JWT_PRIVATE_KEY`;
  the runner verifies it with the matching `RUNNER_JWT_PUBLIC_KEY` at the WS
  handshake (signature, expiry, and an algorithm allow-list that rejects
  `alg:none` and symmetric algorithms) and rejects the upgrade on any failure.
  The verified `org_id` tags the usage metered on `session.done`. Revocation is
  TTL-only today (default 15 min, `RUNNER_JWT_TTL_SECONDS` to override) - no
  deny-list yet (see `docs/cloud-runner-productionization-design.md` section
  1). When no `RUNNER_JWT_PRIVATE_KEY`/`RUNNER_JWT_PUBLIC_KEY` pair is
  configured, both sides fall back to the legacy static `PITCHBOX_RUNNER_TOKEN`
  / `RUNNER_TOKEN` bearer unchanged - the single-tenant self-host path, kept
  for one release. The claim shape (`RunnerJwtClaims`) lives in the OSS
  protocol contract (`shared/src/agents/cloud/protocol.ts`); the signing
  (`shared/src/agents/cloud/jwt.ts`) and verifying (`cloud/runner/src/auth.ts`)
  code each import `jose` independently - the protocol contract itself stays
  dependency-free so it vendors cleanly into the runner.
- **LLM credentials**: the runner owns the Anthropic key/subscription - that is
  the value prop (no local agent CLI or API key needed). The agent in the cloud
  uses the runner's credentials.
- **Billing/quota [IMPLEMENTED, CLD-P5]**: usage is still metered per org on
  the runner from the ACP usage block (tagged with the JWT's `org_id`), and is
  now also enforced at admission. `organizations` carries two nullable
  columns: `monthly_run_budget_usd` (numeric, null = unlimited) and
  `max_concurrent_runs` (integer, null = unlimited). At mint time
  (`shared/src/agents/cloud.ts` -> `resolveRunnerToken`), the client/control
  plane computes a snapshot via `shared/src/org-quota.ts`
  (`getOrgQuotaSnapshot`): `remainingUsd` is the org's monthly budget minus its
  month-to-date run cost (summed from `runs.cost_usd` for runs started since
  the first of the current UTC calendar month, joined to the org through
  `runs.project_id` or `runs.campaign_id` -> `campaigns.project_id`), or
  `null` if the org has no budget configured; `concurrencyCap` is
  `max_concurrent_runs` verbatim, or `null`. This `{ remainingUsd,
concurrencyCap }` snapshot rides in the JWT's `quota` claim
  (`RunnerJwtQuota` in `shared/src/agents/cloud/protocol.ts`). The runner
  (`cloud/runner/src/server.ts`) enforces it purely from the signed claim at
  `session.start` admission, before constructing a session - no DB lookup, so
  the runner stays stateless: it rejects with a `session.error` whose message
  contains `quota_exceeded` when `remainingUsd` is not null and `<= 0`
  (over budget), and separately when `concurrencyCap` is not null and the
  org's current in-memory live-session count is already at the cap. The
  concurrency count is tracked in a `Map<orgId, number>` incremented only on
  an admitted `session.start` and decremented via the same `onTerminal`
  callback that removes a session from the CLD-P3 session registry - so a
  session sitting in its resume grace window (disconnected but not yet
  permanently terminated) still holds its slot, and a rejected admission never
  increments the counter in the first place. Because the JWT is short-lived,
  the snapshot is at most one TTL stale; the next mint reflects any run cost
  recorded in between (no separate ledger table - `runs.cost_usd`, already
  written by the existing dispatch pipeline, is the source of truth). The
  static-token fallback path carries no `quota` claim and stays unenforced,
  same as before this feature. Single-runner-instance caveat carries over from
  the design doc: a multi-instance deployment would need the concurrency cap
  enforced at the control plane at mint time instead, or a shared counter -
  out of scope today.

## Drain on cutover

**[IMPLEMENTED, CLD-P4]** Graceful runner redeploy, so a code cutover does not
kill an in-flight session mid-run. Design record:
`docs/cloud-runner-productionization-design.md` section 4.

- **Runner state machine (`cloud/runner/src/server.ts` + `src/index.ts`).** On
  `SIGTERM`/`SIGINT` the runner enters a draining state: every new
  `session.start` is rejected outright with a `session.error` (`draining`-
  reason message), before a `RunnerSession` is ever constructed. A
  `session.resume` for a sessionId the runner doesn't already hold is rejected
  the same way; a resume for a session that WAS already live when draining
  began is let through unconditionally - reconnecting to already-admitted work
  is not new work, so it is unaffected by draining. Sessions live when
  draining begins are never touched at the start of drain - they keep running,
  and streaming/replay/cancel all keep working normally. The runner exits
  (closes the WS + HTTP servers, `process.exit(0)`) once its session registry
  drains to empty, or once `RUNNER_DRAIN_TIMEOUT_MS` elapses (default 900000,
  15 min - matches the per-session runner-enforced timeout), whichever comes
  first; on the deadline path it force-cancels whatever sessions are still
  live first (logging a warning) rather than leaving them to the container's
  own SIGKILL.
- **`GET /health`** now reports `{ status, draining, activeSessions }` -
  `status` is `"draining"` (HTTP 200 still - a Docker/LB healthcheck keyed off
  a 2xx response must not flag a gracefully-draining container unhealthy) once
  draining has begun, and `activeSessions` is the live session-registry size.
  This is what a deploy/orchestrator polls to learn when a container has
  actually finished draining.
- **Reality check vs. the design doc - runner is internal, not Caddy-fronted.**
  The design's first draft proposed "Caddy connection draining" as the second
  half of the mechanism (host Caddy pinning existing WebSocket connections to
  the old container while routing new ones to the new one, mirroring what it
  already does for the web tier's blue/green cutover). That does not apply
  here: on the actual deploy topology (see `docker-compose.app.runner.yml`),
  the runner is reached only over the internal compose network at
  `ws://runner:8787` - the web dials it directly, and Caddy never sees runner
  traffic at all (only the web app is Caddy-fronted). So for the runner, drain
  is **SIGTERM + a compose `stop_grace_period` that exceeds
  `RUNNER_DRAIN_TIMEOUT_MS`** (set on the `runner` service in
  `docker-compose.app.runner.yml` and in `cloud/runner/docker-compose.prod.yml`
  for a standalone runner deploy), not a proxy-layer draining feature. `docker
compose stop` / `up --force-recreate runner` already sends SIGTERM and waits
  up to `stop_grace_period` before SIGKILLing, so no reverse-proxy config is
  involved on this path.
- **Single-runner-instance caveat (carries over from the design doc's
  load-bearing constraint).** Unlike the web tier, there is only ONE `runner`
  service - no blue/green colors. `scripts/deploy.sh`'s runner cutover step
  (`docker compose up -d --no-deps --no-build runner`, run only after the web
  cutover has already smoke-checked healthy) is therefore a sequential
  stop-then-start when the runner's image actually changed, not a hot swap:
  between the old container fully stopping and the new one becoming healthy,
  there is a bounded window where the client has no runner to dispatch a NEW
  `session.start` to at all (distinct from, and in addition to, the draining
  window itself, during which new starts are explicitly rejected rather than
  simply unreachable). A real blue/green runner (two co-located runner
  services with an internal indirection layer) would close this gap but is
  out of scope for this ticket; today's guarantee is bounded blast radius for
  in-flight sessions (they finish instead of being killed), not zero
  new-session unavailability during a runner deploy.
- **Same-instance-resume implication.** Because resume is strictly
  same-instance (a live session is an in-memory agent process + MCP relay
  bound to one runner instance - see the productionization doc's "load-bearing
  constraint"), a client whose runner is draining simply finishes its run on
  the old container over its existing (or resumed, via reconnect) connection;
  it never tries to resume onto the new instance. If the client reconnects
  after the old container has already exited, the new instance has no record
  of that sessionId, so the resume is rejected (`no resumable session found`)
  exactly like any other unknown-session resume - the client's normal
  fallback is to start a brand new session on the new instance, not to
  continue the old run.

## Observability

**[IMPLEMENTED, CLD-P6]** So drain (CLD-P4) and quota (CLD-P5) are watchable in
production. Design record: `docs/cloud-runner-productionization-design.md`
section 6. Two pieces, both in-memory only (the runner is stateless, so both
reset on restart - fine for a scrape/log-collector target):

- **Structured logs** (`cloud/runner/src/log.ts`): every operational event is
  one JSON object per line, on stdout (`info`) or stderr (`warn`/`error`), of
  the shape `{ event, ts, ...fields }`. `ts` is an ISO 8601 timestamp.

- **`GET /metrics`** (`cloud/runner/src/metrics.ts`, wired into
  `cloud/runner/src/server.ts` alongside `GET /health`): a hand-formatted
  Prometheus text exposition response (no new dependency). Prometheus was
  chosen over extending `/health` because scraping is the standard shape
  ops tooling (Prometheus/Grafana, or any OpenMetrics-compatible collector)
  already expects, and the format is small enough (four metric families) that
  hand-formatting it is cheaper than adding a client library for one
  process's worth of counters.

### No user data, ever

**Hard guarantee**: neither the structured logs nor `/metrics` ever carry
frame contents, playbook text, draft/agent output, or credentials/tokens -
only operational metadata (ids, counts, outcomes, durations, costs). Every log
call site in the runner is limited by construction to a small, reviewed set of
metadata fields (session/org ids, a playbook `slug`, counts, an `outcome`
enum, a duration in ms, a USD amount) - never a field that could carry
arbitrary user-supplied or agent-generated text. `cloud/runner/tests/observability.test.ts`
asserts this with a real negative check: it drives a full session (including
an abnormal agent exit whose stderr contains a distinguishing marker) through
the real server with `console.log`/`warn`/`error` captured, and asserts the
marker never appears in any captured line - while separately confirming the
same marker DOES legitimately reach the client over the WebSocket (the
existing #117 behavior for the session's own client, a different, already-
scoped audience).

**The one deliberate exception, and what changed for it**: on an abnormal
agent exit, `cloud/runner/src/agent.ts` (#117) already captures a bounded
(8KB) tail of the agent's stderr and includes it verbatim in the JSON-RPC
error message delivered to the session's own client (as a `session.error`
frame) - that is unchanged, since it goes to the org that owns the session,
not to a shared log stream. The NEW CLD-P6 `agent.abnormal_exit` structured
log event is deliberately narrower: it carries only `stderrTailChars` (the
tail's length), `code`, and `signal` - never the tail's content. This was a
judgment call (the alternative was capping the log's copy to a shorter
excerpt); length-only was chosen because even a capped excerpt of raw process
stderr could echo back something a caller passed in (an argument, a path, or
a fragment of prompt content surfaced in a framework stack trace), and a
length plus the exit code/signal is already enough to alert on and correlate
with the client-facing error for the same session.

While implementing this, `AcpAgent.cancel()` (called at the end of every
session, success or not, as routine teardown) turned out to SIGTERM even a
perfectly healthy agent - and for a backend with no SIGTERM handler of its
own, Node reports that as `signal: 'SIGTERM'` on exit, which is
indistinguishable, at the OS level, from a real crash-by-signal. `AcpAgent`
now tracks a `cancelRequested` flag (set by `cancel()`) so `onAbnormalExit`
only fires for an exit the runner did NOT itself request - a routine teardown
kill is not "abnormal" for observability purposes, even though it exits via a
signal. This did not change the existing client-facing error message path
(`tests/agent.test.ts` covers both).

### Log event catalog

| Event                    | Level                              | Fields (beyond `event`/`ts`)                                                                                                   | Fires when                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.admitted`       | info                               | `sessionId`, `orgId`, `slug`, `activeSessions`, `orgActiveSessions`                                                            | A `session.start` passes every admission check (protocol version, duplicate-id, CLD-P4 drain, CLD-P5 quota) and a `RunnerSession` is constructed. Counts are post-admission.                                                                                          |
| `session.terminated`     | info                               | `sessionId`, `orgId`, `outcome` (`done`\|`error`\|`cancelled`\|`timeout`), `durationMs`, `activeSessions`, `orgActiveSessions` | A session becomes permanently unresumable (the same `onTerminal` callback CLD-P3's registry and CLD-P5's concurrency counter use - see "Wiring" below). Counts are post-removal.                                                                                      |
| `quota.rejected`         | info                               | `sessionId`, `orgId`, `kind` (`budget`\|`concurrency`)                                                                         | CLD-P5 admission refuses a `session.start`: `budget` when `quota.remainingUsd <= 0`, `concurrency` when the org is already at `quota.concurrencyCap`.                                                                                                                 |
| `draining.rejected`      | info                               | `sessionId`, `orgId`, `frame` (`session.start`\|`session.resume`)                                                              | CLD-P4 refuses a new `session.start`, or a `session.resume` for a sessionId the runner doesn't hold, while draining.                                                                                                                                                  |
| `drain.start`            | info                               | `activeSessions`, `drainTimeoutMs`                                                                                             | The first call to `drain()` (SIGTERM/SIGINT) - not re-logged on a redundant second signal, since `drain()` is idempotent.                                                                                                                                             |
| `drain.complete`         | info (or **warn** when `timedOut`) | `timedOut`, `activeSessions` (remaining, pre-force-cancel count)                                                               | The drain promise settles - either the registry emptied out on its own (`timedOut: false`), or the drain deadline elapsed and force-cancelled whatever was left (`timedOut: true`, logged at `warn`; this is the "logged warning" the drain-deadline path performs).  |
| `agent.abnormal_exit`    | warn                               | `sessionId`, `orgId`, `code`, `signal`, `stderrTailChars`                                                                      | The spawned agent process exits abnormally (nonzero code or a signal) for a reason the runner did NOT itself request via `cancel()` - see "No user data, ever" above for why content is excluded.                                                                     |
| `runner.usage`           | info                               | `sessionId`, `orgId`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalCostUsd`                  | A session reaches `session.done` with usage - the existing usage-metering log line, now routed through the structured logger (previously an ad-hoc `console.log(JSON.stringify(...))`) and, in the production wiring, also fed into `pitchbox_runner_cost_usd_total`. |
| `runner.signal_received` | info                               | `signal` (`SIGINT`\|`SIGTERM`)                                                                                                 | Every SIGINT/SIGTERM the process receives (`cloud/runner/src/index.ts`), including a redundant second signal - distinct from `drain.start`, which only fires once.                                                                                                    |

### Metrics (`GET /metrics`)

| Metric                                      | Type    | Labels                                                    | Description                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pitchbox_runner_active_sessions`           | gauge   | none (total), `org` (per-org)                             | Live sessions right now. Read directly from the same in-memory session registry and per-org concurrency map CLD-P3/CLD-P5 already maintain (see "Wiring" below) - not a separate counter, so it cannot drift from what `/health`'s `activeSessions` reports. A session inside its CLD-P3 resume grace window (disconnected but not yet permanently terminated) still counts. |
| `pitchbox_runner_sessions_terminated_total` | counter | `outcome` (`done`\|`error`\|`cancelled`\|`timeout`)       | Sessions that have reached a terminal outcome, since this runner instance started.                                                                                                                                                                                                                                                                                           |
| `pitchbox_runner_cost_usd_total`            | counter | `org` (`"none"` for the legacy no-auth/static-token path) | Cumulative metered LLM cost in USD, since this runner instance started - fed from the same `session.done` usage the runner already meters for billing.                                                                                                                                                                                                                       |
| `pitchbox_runner_draining`                  | gauge   | none                                                      | `1` once CLD-P4 draining has begun, `0` otherwise - the same `draining` flag `/health`'s `status`/`draining` fields report.                                                                                                                                                                                                                                                  |

### Wiring (no duplicated lifecycle source of truth)

`cloud/runner/src/metrics.ts`'s `RunnerMetrics` class deliberately does NOT
track active-session counts or the draining flag itself - `/metrics` reads
`server.ts`'s own `sessions` Map, `orgConcurrency` Map, and `draining` flag
(the same CLD-P3/CLD-P4/CLD-P5 state `/health` already reports from) directly
at scrape time. `RunnerMetrics` only owns the two counters that didn't exist
anywhere else before this feature: terminal-outcome counts and cumulative
per-org cost. Both are updated from the exact same callbacks CLD-P3/CLD-P5
already rely on for the session registry and concurrency count - `recordOutcome`
and the `session.terminated` log both fire from the session's `onTerminal`
callback (server.ts), and `addCost` fires from the session's `meter` callback
(server.ts, alongside the `runner.usage` log) - so admission, termination, and
cost are each logged/metered from a single call site, not a second,
independently-maintained lifecycle.

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
