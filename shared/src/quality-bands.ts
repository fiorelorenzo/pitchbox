// shared/src/quality-bands.ts
//
// The client-safe half of quality scoring: the rubric's shape and its
// thresholds, the sentinel that says a score was computed rather than
// judged, and the mapping from a number to the band the Inbox paints. All
// pure, all of it needed by a Svelte component, none of it needing a
// database or a model.
//
// It is a separate module for one concrete reason, found on merged `main`
// on 2026-09-11 and not on any single branch. `quality-judge.ts` gained a
// real judged component in LOR-229 and with it top-level imports of `ai`,
// `@ai-sdk/gateway` and `./operator-voice-profile.js`, which reaches the
// `pg` client. `DraftListItem.svelte` and `DraftDetail.svelte` import
// `scoreBand` and `DETERMINISTIC_QUALITY_MODEL` from that same module, so
// the whole server stack landed in the browser bundle and the Inbox failed
// to hydrate: the sidebar rendered and the page itself showed "500
// Internal Error". Server-rendered HTML was correct, which is why nothing
// caught it short of loading the page.
//
// `quality-judge.ts` re-exports everything here, so no server caller
// changes. Nothing in this file may import anything that is not also pure:
// `shared/tests/quality-bands.test.ts` asserts that by reading the source,
// because the failure mode is a transitive import nobody looks at.
//
// Same shape and same reason as `quota-types.ts` next to `quota-server.ts`.

/** The rubric the judged component reads, and the two thresholds the band
 * mapping below uses. Stored in `app_config.quality_rubric`. */
export interface QualityRubric {
  rubric_template: string;
  threshold_red: number;
  threshold_green: number;
}

export const DEFAULT_QUALITY_RUBRIC: QualityRubric = {
  rubric_template:
    'Score this draft from 0-100 on whether it reads as something a real person actually wrote and sent, not a generic AI reply. Weigh: would a reader take this for a person rather than a bot; does it say one concrete thing rather than vague encouragement; does it answer this specific post rather than any post on the same subject; and is it roughly the length a real reply in this room runs, not a small essay. Return JSON {"score": number, "reason": string}.',
  threshold_red: 40,
  threshold_green: 75,
};

/** `drafts.quality_model`'s sentinel for "computed, not judged" - as real a
 * value as an actual Gateway model id, never confused with one (no `/` in
 * it, unlike every Gateway id). */
export const DETERMINISTIC_QUALITY_MODEL = 'deterministic';

export type QualityBand = 'red' | 'amber' | 'green' | 'none';

/** Maps a score to the band the Inbox paints. `none` is "not measured",
 * which is a real answer rather than a bad one: an organization with no
 * voice corpus and a draft with no style findings has nothing to score
 * against, and the badge says so instead of inventing a number. */
export function scoreBand(score: number | null | undefined, rubric: QualityRubric): QualityBand {
  if (score == null) return 'none';
  if (score < rubric.threshold_red) return 'red';
  if (score >= rubric.threshold_green) return 'green';
  return 'amber';
}
