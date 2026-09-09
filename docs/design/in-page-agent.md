# The in-page assistant as an agent - design of record

Status: decided 2026-09-09. Issue #565, epic #564. This document settles the
three things every other issue in that epic consumes, so they are referenced
rather than re-argued: **where the loop runs**, **what it may spend**, and
**what it is allowed to know and do**.

It supersedes one sentence of `docs/linkedin-integration-design.md`, which
still says "One shot, no tool loop, no `runs` row driving it". That sentence
describes what shipped in #312 and is accurate about today's code; #577 is the
issue that rewrites it once this epic lands. The approved surface brief
(`docs/design/linkedin-assistant-brief.md`) and the compliance boundary are
**unchanged by everything below**: nothing here relaxes a rule, and the two
rules worth restating are that the assistant reads only what the human's own
browsing rendered, and that no code on either side ever issues a request
toward linkedin.com or licdn.

## Where we are starting from

Measured, not remembered:

- The suggestion is one streaming call. `runSuggestion`
  (`web/src/lib/server/suggest.ts`) builds a prompt, spawns a runner with
  `attachMcp: false`, splits reasoning from draft through `EnvelopeSplitter`,
  and returns one turn's usage. `SUGGESTION_TIMEOUT_MS` is 90s.
- Latency, on an idle box, same 3043-character prompt, `claude-code`, n=3
  (recorded at `web/src/lib/server/suggest.ts:75-94`, from #360): the pinned
  fast model reaches first token in 10.4s median and finishes in 12.9s; the
  unpinned session default takes 16.8s and 19.8s. **Process spawn plus
  `session/new` is 2.2s of that**, so the wait is the model deliberating, not
  the plumbing.
- Everything the assistant knows is loaded unconditionally and pasted into the
  prompt (`shared/src/assist/context.ts`, `shared/src/assist/suggest-prompt.ts`):
  persona, voice profile summary, up to 6 org projects, up to 4 GitHub repos
  with README excerpts and 5 commit subjects each, up to 3 examples, and the
  post, each with its own clamp.
- Two runner shapes exist. `SdkRunner` (`shared/src/agents/sdk/runner.ts`)
  runs in-process against the AI Gateway, already accumulates usage across
  steps, and already passes a tool set to `streamText` when `attachMcp` is not
  `false`. `AcpRunner` (`shared/src/agents/acp/runner.ts`) spawns a coding-agent
  CLI and speaks ACP, and already handles `session/request_permission`, so tool
  calls are native to it.
- The campaign MCP server (`cli/src/mcp/server.ts`) exposes 26 tools, most of
  them writers (`drafts_create`, `run_finish`, `drafts_update`, …), scoped by
  `checkOwnership` against the session's org.

## 1. Where the loop runs

**Decision: the tool surface is declared once in `shared`, every tool executes
server-side in our own process, and each runner drives the loop in its native
idiom - native tool calls for the SDK runner, a purpose-built assist MCP server
for the ACP runner. The handler functions are the same objects in both paths.**

This is the recommendation #565 asked to be argued against, and it survives the
argument, for one reason that outranks the others: **the authentication model.**
A self-host authenticates through the human's own `claude` CLI subscription and
has no provider API key. Running the loop in-process with the AI SDK on both
editions would require one, which would break self-hosting to buy a faster
first token. That trade was already refused once, in the brief, and nothing has
changed to reopen it.

The two rejected alternatives, so nobody re-derives them:

- **Reuse the campaign MCP server with `attachMcp: true`.** Rejected. That
  server is a different plane with different privileges: 26 tools, most of them
  writers, bound to a `runs` row. The assist plane's isolation from the campaign
  plane is the whole point of #520, and handing the assistant `drafts_create`
  and `run_finish` because they happen to be in the same process would undo it.
  #567 says the campaign surface stays untouched, and it is right.
- **Run the loop client-side in the panel, calling our API per step.** Rejected.
  Every step would cross the extension boundary, the step budget would be
  enforced where the caller can ignore it, and the model's tool arguments would
  arrive from a context an attacker controls. The enforcement rule this repo
  already learned the hard way (#358: the assist switch enforced only in the
  extension) applies exactly.

What this means concretely:

- `shared/src/assist/tools.ts` declares each tool: its name, its JSON schema,
  its clamps, and an async handler `(ctx, args) => result` where `ctx` carries
  the org id, the bound project id, the observed target and the operator - all
  server-resolved, none of it model-supplied.
- The SDK path wraps those handlers as native tools. `SdkRunner` needs a way to
  be given a tool set that is **not** the campaign `PitchboxToolSet`; that is
  the one runner change this epic needs, and it is additive.
- The ACP path gets a second stdio MCP entry point (`bin/pitchbox-assist-mcp`,
  a sibling of `bin/pitchbox-mcp`) that exposes **only** these tools and binds
  its session to an org and a project rather than to a run. It shares the
  handlers with the SDK path, so a scoping test written once covers both.
- Cost of the ACP path: one extra process per suggestion. Acceptable, because
  that path already spawns a CLI and pays 2.2s for it; the assist MCP server is
  a node process with no model call in it.

**One implementation of every tool, two transports.** If a future edition needs
a third, it wraps the same handlers.

## 2. The step and budget contract

A human is watching an empty panel, so the budget is a product decision, not a
safety valve. The numbers, and where each comes from:

| Constant                   | Value               | Why                                                                                                                                                                                             |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSIST_MAX_STEPS`         | 6                   | Five tool steps plus the writing turn. The heaviest realistic plan is thread, image, author history, voice, prior takes, then write.                                                            |
| `ASSIST_SOFT_BUDGET_MS`    | 35_000              | Past this the agent is told to answer with what it has. Two model turns plus parallel DB reads fit inside it with room: one turn is 10 to 13s measured.                                         |
| `ASSIST_HARD_TIMEOUT_MS`   | 90_000              | Unchanged from today's `SUGGESTION_TIMEOUT_MS`. The ceiling, not the target.                                                                                                                    |
| `ASSIST_TOOL_TIMEOUT_MS`   | 4_000               | A DB-backed tool that cannot answer in 4s is broken, and the loop must not wait on it.                                                                                                          |
| `ASSIST_VISION_TIMEOUT_MS` | 12_000              | `look_at_image` is a real model call and the only tool that spends tokens.                                                                                                                      |
| `ASSIST_TOKEN_BUDGET`      | 60_000 input tokens | Accumulated across steps. Past it, no further tool result is admitted into the context and the agent is told to answer. #574 owns replacing this with a measured number and a per-plan ceiling. |

**At the soft budget the agent is instructed to answer now, and at the hard
ceiling whatever draft text has already streamed is what the operator gets.** A
partial suggestion beats an error: the panel is a text box a human is about to
edit anyway, and a timeout that produces nothing is the worst outcome on this
surface. If nothing at all has streamed, the panel gets a refusal it can render
(the shape already used by `quota_exhausted` and `kill_switch`), never a 500.

**Parallelism.** Every DB-backed tool may run in parallel with every other:
`read_thread`, `author_history`, `operator_voice`, `project_knowledge`,
`my_prior_takes`. Four sequential round trips against Postgres for no reason is
the difference this epic is buying. Two exceptions: `look_at_image` runs alone,
because it is a model call whose cost and latency dwarf the others, and
`check_style` runs last, after a draft exists, and never concurrently with the
writing turn.

**Cancellation.** The current code already carries an authoritative `cancelled`
flag plus a best-effort handle for the window before the runner exists. A loop
has _more_ such windows, so the flag is checked between every step and before
every tool handler runs, and a cancelled suggestion must stop spending: no tool
handler starts, no further model turn is requested. A suggestion nobody is
waiting for that keeps calling the Gateway is a bug that only shows up on the
bill.

**Usage.** `SuggestionResult.usage` becomes the sum across steps, since the
accept path writes it into the ledger and the plan's suggestion cost reads it
(#546, #547). The `assist_usage` row records the same total, and #522's rule
stands: a suggestion is ledgered when the stream finishes, whether or not a
human accepts it.

## 3. What the agent may know and do

Seven tools, all read-only, each taking its authority from the session and
never from an argument the model supplies. The full contracts are #567's; what
this document fixes is the authority model and the refusals.

| Tool                | Model-supplied arguments                                                     | Server-supplied authority                                 | Refuses                                                            |
| ------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `read_thread`       | none                                                                         | the observed target captured for this device and org      | nothing rendered -> explicit "no thread captured"                  |
| `look_at_image`     | none                                                                         | the crop captured with that target                        | no image -> explicit nothing; never a fetch of a remote asset      |
| `author_history`    | none                                                                         | org id, the post author's handle from the captured target | no history -> explicit "no prior contact", which is information    |
| `operator_voice`    | none                                                                         | operator profile for this org                             | thin evidence -> the defaults from #571, never an invented profile |
| `project_knowledge` | project id **only if** it is the bound project or the org's personal project | org id, bound project                                     | any other project id -> refusal, not an empty result               |
| `my_prior_takes`    | a lexical query string                                                       | org id, operator identity                                 | no match -> explicit nothing                                       |
| `check_style`       | the draft text                                                               | none                                                      | never refuses; it is deterministic                                 |

Rules that hold for all of them:

- **The org and the bound project come from the session.** A tool that accepted
  an org id from the model would be a cross-tenant hole one hallucination wide.
  `project_knowledge` is the only tool with an id argument at all, and it is
  validated against the binding rather than trusted.
- **A tool that has nothing to say returns an explicit nothing**, not an empty
  string. "No prior contact with this person" is the fact that prevents
  greeting somebody as a stranger after three exchanges.
- **Every payload is clamped** with the same discipline the prompt builder
  already uses, and the clamp is marked so the model knows it was truncated.
- **No tool writes anything.** Not a draft, not an observation, not a run row.
  The accept path stays the single place where the assist plane touches
  durable state (#520/#521).

**Explicit non-goals for v1**, each with its reason:

- **No web search.** Latency, and a source the operator cannot check before he
  posts under his own name.
- **No LinkedIn request of any kind**, from either side. Rule 1 of the
  compliance checker, and the reason the image reaches the model as pixels
  captured from the rendered tab rather than as a licdn URL the server fetches.
  That distinction is easy to get wrong in the opposite direction, so: **capture
  the rendered tab, never fetch licdn.**
- **No writing anywhere**, and no filesystem or shell reach. The runner session
  keeps its empty temp cwd; the tools are the only capability added.
- **No cross-tenant read.** Another org's projects, drafts, contacts or
  operator profile are unreachable by construction, not by filter.
- **The agent never sees a credential.** Not the extension device token, not
  the Gateway key, not a GitHub installation token. What it sees of a repo is
  the cached `github_sources` excerpt.
- **A plan's entitlements bind the loop.** An org whose plan does not allow
  premium models runs on the function's fast default (#547), and the loop's
  budget is not a way around a spend limit: the org's own ceiling and the
  instance ceiling both still apply where they already do.

## What this changes for the issues that consume it

- #566 changes the middle of `runSuggestion` and nothing about its contract
  with the route: still SSE, still reasoning split from draft, still cancellable,
  still returning a usage block.
- #567 implements the seven handlers plus the assist MCP entry point, with the
  scoping tests written against the handlers so both transports are covered.
- #573 narrates the steps into the existing `status` event rather than inventing
  a second channel; the phases it can honestly report are the tool names above.
- #574 replaces `ASSIST_TOKEN_BUDGET` with a measured number, and is the issue
  that may move any figure in the table above. Anyone else changing one edits
  this document in the same PR.
