// shared/src/assist/budget.ts
//
// Every number the in-page assistant's agent loop is allowed to spend,
// named once so nothing re-declares it - docs/design/in-page-agent.md,
// "The step and budget contract", is the argument for each value below.
// #574 is the only issue allowed to move one, and it edits that document in
// the same PR.
//
// A human is watching an empty panel, so these are product decisions, not
// safety valves: past ASSIST_SOFT_BUDGET_MS the agent is told to answer with
// what it has, and at ASSIST_HARD_TIMEOUT_MS whatever draft text already
// streamed is what the operator gets. A partial suggestion beats an error.

/** Five tool steps plus the writing turn - the heaviest realistic plan is
 * thread, image, author history, voice, prior takes, then write. */
export const ASSIST_MAX_STEPS = 6;

/** Past this the agent is told to answer with what it has. Two model turns
 * plus parallel DB reads fit inside it with room: one turn measures 10 to
 * 13s (design doc, "Where we are starting from"). */
export const ASSIST_SOFT_BUDGET_MS = 35_000;

/** The ceiling, not the target. Unchanged from today's `SUGGESTION_TIMEOUT_MS`
 * (`web/src/lib/server/suggest.ts`). */
export const ASSIST_HARD_TIMEOUT_MS = 90_000;

/** A DB-backed tool that cannot answer in 4s is broken, and the loop must not
 * wait on it. Applies to every tool below except `look_at_image`. */
export const ASSIST_TOOL_TIMEOUT_MS = 4_000;

/** `look_at_image` is a real model call and the only tool that spends
 * tokens, so it gets its own, longer budget. */
export const ASSIST_VISION_TIMEOUT_MS = 12_000;

/** Accumulated input tokens across every step. Past it, no further tool
 * result is admitted into the context and the agent is told to answer.
 *
 * Measured 2026-09-09 for #574 rather than left at the design estimate:
 * the worst realistic plan (every one of the five read-only DB tools
 * called once, sequentially, then the write turn) adds at most ~4,500
 * tokens of new context - `read_thread`'s `MAX_THREAD_CHARS` (6,000 chars),
 * `author_history`'s five drafts plus five messages at 300 chars each,
 * `operator_voice`'s 1,200-char persona plus 500-char summary,
 * `project_knowledge`'s four repos plus description plus two insights, and
 * `my_prior_takes`'s five 400-char excerpts (every clamp named here is the
 * real constant in `shared/src/assist/tools.ts` and `suggest-prompt.ts`,
 * not an estimate). At ~4 chars/token that tops out around 7,000 tokens on
 * the final turn - about 12% of this budget - so **60,000 stays**: it was
 * never close, and the number worth moving turned out to be a dollar
 * ceiling, not this one (see `ASSIST_COST_CEILING_USD` below, which is
 * what #574 actually added). Method and the full measured table: PR for
 * #574, and issue #574's own comment thread. */
export const ASSIST_TOKEN_BUDGET = 60_000;

/**
 * Per-suggestion USD ceiling, enforced the same way as the three budgets
 * above (`shared/src/agents/sdk/runner.ts`'s `prepareStep`): past it, the
 * next step is offered no tools and the model is told to answer with what
 * it has - never an abort, because "a ceiling that produces an error
 * instead of a draft is the wrong shape on this surface" (design doc,
 * "a partial suggestion beats an error"). Distinct from two ceilings that
 * stay exactly as they are: the org's own monthly Gateway budget
 * (`shared/src/org-quota.ts`, `budgetRemainingUsd`, #419 - a hard abort,
 * by design, since it is the org's last line rather than one suggestion's)
 * and the instance-wide ceiling (design doc, "the org's own ceiling and the
 * instance ceiling both still apply where they already do"). Neither of
 * those two knows about one suggestion in isolation, which is exactly what
 * this one bounds.
 *
 * Measured 2026-09-09, method below - this box has no `AI_GATEWAY_API_KEY`
 * (self-host posture, `AGENTS.md`), so a live cloud-runner dispatch was not
 * possible here; every number is either a real recorded suggestion or a
 * deterministic count from the shipped clamps, never a guess:
 *
 *   fast default, no tools (real, 3 suggestions recorded in the preview
 *   database before the tool loop shipped, SSH-verified 2026-09-09):
 *     avg 2,619 input + 212 output tokens, $0.00097 -
 *     `google/gemini-3.1-flash-lite` at a derived ~$0.31/M input,
 *     ~$0.69/M output (solved exactly from the 3 rows, confirmed against
 *     the 3rd)
 *
 *   fast default, worst realistic tool loop (deterministic: every DB tool
 *   called once, sequentially, no prompt-cache credit - the 3 real rows
 *   above show zero cached tokens for this model):
 *     ~30,700 cumulative input + ~460 output tokens across 6 turns,
 *     peaking at ~7,000 tokens on the final turn -> **~$0.010**, about
 *     10x the no-tool baseline
 *
 *   premium/Claude-class, no tools (already on record - #360, cited in
 *   #574's own issue body, not re-derived here): **$0.036 to $0.107**
 *   per suggestion
 *
 *   premium/Claude-class, worst realistic tool loop: the same token growth
 *   applies, but a premium model earns a real prompt-cache discount on the
 *   repeated prefix each turn resends (~90% off on a cache read, unlike the
 *   fast path above) - so the naive 12x multiplier the fast-path numbers
 *   would imply overstates it. Estimated **$0.15 to $0.30** per suggestion:
 *   the recorded premium ceiling as the single-turn floor, plus the same
 *   worst-case tool shape at a cache-discounted rate
 *
 *   `look_at_image` (priced separately, inside its own handler against
 *   whichever model `assist_vision` resolves to - `shared/src/assist/
 *   tools.ts`, #574): a few hundred output tokens plus one image, ~1,000 to
 *   1,500 tokens by the published per-image formula for a crop this size -
 *   low single-digit cents even on the premium model
 *
 * $0.50 leaves roughly 1.7x to 3.3x headroom over the heaviest estimated
 * real case above (premium, every tool, one image) while still stopping a
 * genuine runaway - a model retrying a tool, an unusually large cached
 * context - well short of a meaningful fraction of any plan's monthly
 * allowance (the free plan's 50 suggestions, gated to the fast default by
 * #547's premium-model gate, could never reach this model class at all).
 * A free-plan run of the fast-only worst case (~$0.010) sits at 2% of this
 * ceiling, so it is not expected to ever trip there.
 */
export const ASSIST_COST_CEILING_USD = 0.5;
