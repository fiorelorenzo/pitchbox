# Cloud runner productionization (design)

Status: DESIGN (for review). Issue #131. This builds on the shipped cloud runner
([`docs/cloud-runner.md`](cloud-runner.md)) and the hardening already landed in
epic #80 (real frame validation, protocol version handshake, an independent runner
session timeout, bounded stderr capture). It closes the three items that page left
`[OPEN]`: per-org WS auth (a static bearer is wired today), reconnect/resume, and
graceful redeploy, plus the per-org quota enforcement `docs/auth.md` defers.

The decisions below are tagged **[LOCKED]** (follows directly from an existing
locked principle), **[PROPOSED]** (my recommended call, open to change on review),
or **[OPEN]** (needs a human decision before build). Since this is a security- and
billing-adjacent surface, the `[PROPOSED]` calls should get a review pass before
implementation starts.

## The load-bearing constraint

The runner is stateless with respect to **data** (no DB, no user data at rest), but
a _live session_ is not stateless: it owns an in-memory ACP agent child process and
an MCP relay bound to one runner instance. Two consequences shape every decision
here:

1. **Resume is same-instance.** A client can drop and re-attach to a session only
   while that session's process is still alive on the same runner instance. There
   is no cross-instance session migration (that would require serializing a live
   agent + an in-flight LLM turn, which is out of scope and probably infeasible).
2. **Cutover is drain, not migrate.** A redeploy cannot move live sessions to the
   new instance. It must let them finish on the old instance (drain) while new
   sessions start on the new one.

Everything below respects this: reconnect/resume covers network blips against a
still-running instance; drain covers redeploys; the two compose (a client whose
runner is draining keeps its existing connection to the old instance until the run
finishes, and only new runs land on the new instance).

## 1. Per-org runner tokens [PROPOSED]

Today a single static `RUNNER_TOKEN` bearer authorizes every web to runner
connection. Productionized, each organization authenticates with its own,
revocable, attributable credential, without giving the stateless runner a database.

**Model: short-lived asymmetric JWT, minted client/control-plane side, verified by
the runner.**

- The client (control plane) holds a signing private key; the runner holds only the
  public key (`RUNNER_JWT_PUBLIC_KEY`). The runner verifies signatures locally, so
  it stays stateless: no token store, no callback to validate.
- Claims: `{ org_id, iat, exp, jti, scope, quota }`. `org_id` scopes usage metering
  and quota (see section 5). `exp` is short (**[PROPOSED]** 15 min); the client
  refreshes on connect and on each reconnect, so a revoked/expired org cannot start
  or resume a session past one TTL window.
- Presented in the WebSocket handshake `Authorization: Bearer <jwt>` header (where
  the static token already lives), **not** in the `session.start` frame, so a
  malformed or unauthenticated frame never reaches session construction. The runner
  rejects the upgrade on a missing/invalid/expired/wrong-`org` token.
- Hard revocation beyond TTL is **[OPEN]**: either accept the <=15 min window, or
  have the runner poll a small deny-list of `jti`/`org_id` from the control plane.
  Recommend shipping with TTL-only and adding the deny-list only if a real "revoke
  now" requirement appears.
- Migration: keep the static `RUNNER_TOKEN` working behind a flag for one release
  (self-hosters who run a single-tenant runner do not need per-org JWTs), and prefer
  the JWT when a public key is configured.

Rationale: the JWT keeps the "runner is stateless" principle intact, carries the org
identity the metering path already wants, and folds the quota snapshot into the same
signed artifact (section 5). Alternatives considered: opaque per-org tokens with a
runner-side store (breaks statelessness) or a validate-endpoint callback per connect
(adds a control-plane round-trip and a hard dependency on the control plane being up
at connect time).

## 2. WS transport resilience: heartbeat + reconnect [PROPOSED]

The prerequisite for resume, and independently useful.

- **Heartbeat.** Both ends run WS ping/pong on an interval (**[PROPOSED]** 20s ping,
  60s dead-peer timeout). A missed pong marks the link dead promptly instead of
  waiting on TCP timeouts. The runner's independent session timeout (#115) remains
  the absolute backstop.
- **Client reconnect.** On an unexpected socket close while a run is still in
  progress, the adapter reconnects with exponential backoff + jitter (**[PROPOSED]**
  base 500ms, cap 15s) up to the session's remaining lifetime, instead of
  immediately failing the run promise as it does today.
- This layer changes only the adapter and adds ping/pong on the runner; it does not
  yet preserve in-flight work (that is section 3). Shipped alone it already turns a
  transient blip into a clean retry rather than a lost run for the control-channel
  case.

## 3. Resumable sessions [PROPOSED]

Make a reconnect (section 2) transparent to an in-progress run on the same instance.

- **Session grace window.** On client disconnect, the runner does not tear the
  session down immediately; it holds it for a grace window (**[PROPOSED]** 60s,
  clamped to the remaining session timeout) waiting for a resume. If none arrives,
  it cleans up exactly as the #115 timeout path does.
- **Frame sequencing + replay.** The runner stamps every `RunnerToClient` frame with
  a monotonic `seq`. The client tracks the highest `seq` it has durably processed.
  On reconnect it sends a new `session.resume { sessionId, lastSeq }` frame; the
  runner replays buffered frames with `seq > lastSeq` (it keeps an un-acked ring
  buffer per session, bounded; if the buffer overflowed during a long
  disconnect, it fails the resume and the run ends cleanly). The `session.start`
  version handshake and org token are re-presented on the resume connection.
- **Idempotent client persistence.** Event replay must not double-write
  `run_events`. The client dedups on `seq` (or the event identity it already
  persists) so `dispatchRun` persistence is idempotent under replay. This is the one
  correctness-critical piece and needs a test that replays overlapping ranges.
- **In-flight MCP calls.** The hard case: an MCP tool call (agent -> runner relay ->
  WS -> client) mid-flight when the socket drops. The runner's HTTP relay request
  from the agent is already a blocking request/response, so the runner holds it open
  across the grace window; if the client resumes in time, the reissued/awaited
  response completes it transparently, and if the window expires the relay returns an
  MCP error to the agent and the run fails cleanly. The client must make re-executed
  tool calls safe: **[OPEN]** whether we need per-call idempotency keys for
  write-side MCP tools (`drafts.create`, `run.finish`) or whether holding the single
  in-flight call open (never re-executing it) is sufficient. Recommend the latter
  (hold-open, never re-execute) to avoid an idempotency-key layer.

Scope guard: resume is strictly same-instance (see the load-bearing constraint). The
resume frame that lands on a _different_ instance (which has no such session) is
rejected with `session.error`, and the client surfaces a normal run failure.

## 4. Drain on cutover [PROPOSED]

Graceful runner redeploy, composing with the blue-green deploy hardening (#108) just
landed.

- **Runner draining.** On `SIGTERM`, the runner stops accepting new WS upgrades and
  new `session.start` frames (replying `session.error` / a `draining` reason to any
  new start), keeps existing sessions running to completion, and exits once idle or
  at a drain deadline (**[PROPOSED]** matches the max session timeout, with a hard
  cap). In-flight sessions are never hard-killed at the start of drain.
- **Proxy connection draining.** The edge (Caddy on prodbox) must keep existing
  WebSocket connections pinned to the old container until they close, routing only
  new connections to the new container. Verify/configure Caddy's connection-draining
  behavior for the cutover; document it.
- **Deploy gate.** The blue-green cutover marks the new container healthy, shifts new
  traffic, then waits for the old container to drain (a readiness/`/health` signal
  that reports active-session count) before retiring it, bounded by a max-drain
  timeout after which it force-stops with a logged warning.
- Because resume is same-instance, a client on the draining old instance simply
  finishes there; it does not try to resume onto the new instance.

## 5. Per-org quota enforcement [PROPOSED]

Today usage is metered on `session.done` but nothing is enforced. Enforce at
admission and bound concurrency, without giving the runner a database.

- **Admission from the token.** The JWT's `quota` claim carries the control plane's
  snapshot of the org's remaining budget and its concurrency cap at mint time. The
  runner refuses `session.start` when the snapshot shows the org is over budget
  (`session.error` with a `quota_exceeded` reason). Because tokens are short-lived,
  the snapshot is at most one TTL stale.
- **Concurrency.** The runner is the one process actually running an org's sessions,
  so it tracks a per-`org_id` in-memory active-session count and enforces the cap
  from the claim. (Single-instance today; a multi-instance future would need the cap
  enforced at the control plane at mint time instead, or a shared counter, flagged
  **[OPEN]**.)
- **Ledger.** Live token/USD usage still meters back on `session.done` to the client,
  which updates the org's ledger; the next token mint reflects the new balance. Units
  **[OPEN]**: monthly USD vs tokens vs runner-minutes; recommend USD (the runner
  already computes cost) plus a concurrency cap.

## Non-goals

- Cross-instance session migration / serializing a live agent turn.
- A multi-runner horizontal-scale scheduler (single runner instance today; the
  design notes the two `[OPEN]` multi-instance seams but does not build them).
- Changing the compute/data boundary: data and credentials stay client-side exactly
  as today.

## Protocol delta (summary)

Additions to `shared/src/agents/cloud/protocol.ts` (OSS wire contract, kept
dependency-free; vendored copy in `cloud/runner` re-synced + drift-guarded):

- `RunnerToClient` frames gain a monotonic `seq: number`.
- New `ClientToRunner` frame `session.resume { sessionId, lastSeq, version }`.
- New `RunnerToClient` reason values: a `draining` start-rejection and a
  `quota_exceeded` start-rejection (both via the existing `session.error`).
- WS handshake `Authorization` carries the per-org JWT instead of the static token.
- `CLOUD_PROTOCOL_VERSION` bumps (the frame shape changes), and the handshake check
  from #116 gates old/new peers.

## Phased build order [PROPOSED]

Dependencies: tokens (P1) underpin quota (P5); heartbeat/reconnect (P2) underpins
resume (P3) and drain (P4).

1. **P1 - per-org tokens.** JWT mint (client/control plane) + runner verification,
   `org_id` scoping on metering, static-token fallback flag. Protocol + runner +
   adapter + client mint. Ships first (security foundation).
2. **P2 - heartbeat + reconnect.** Ping/pong + adapter backoff reconnect. Independent,
   immediately useful.
3. **P3 - resumable sessions.** `seq` + server buffer + `session.resume` + idempotent
   client replay + in-flight MCP hold-open. Depends on P2. The correctness-critical
   piece; heavy tests.
4. **P4 - drain on cutover.** Runner SIGTERM draining + Caddy connection draining +
   blue-green drain gate. Depends on P2 (and composes with #108).
5. **P5 - per-org quota enforcement.** Admission from the JWT quota claim + in-memory
   concurrency cap + ledger update on `session.done`. Depends on P1.
6. **P6 - observability (optional).** Per-org/session structured logs + active-session
   and per-org-usage metrics, so drain and quota are observable.

## Open questions for review

- **[OPEN]** Hard token revocation: TTL-only vs a `jti`/`org` deny-list the runner
  polls.
- **[OPEN]** In-flight write-side MCP tools on resume: hold-open-only (recommended)
  vs per-call idempotency keys.
- **[OPEN]** Quota units: USD vs tokens vs runner-minutes (recommend USD +
  concurrency cap).
- **[OPEN]** Multi-instance seams (concurrency cap, cross-instance routing) - out of
  scope now, but P1/P5 should not foreclose them.
