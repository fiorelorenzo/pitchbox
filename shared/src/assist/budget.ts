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
 * result is admitted into the context and the agent is told to answer. #574
 * owns replacing this with a measured number and a per-plan ceiling. */
export const ASSIST_TOKEN_BUDGET = 60_000;
