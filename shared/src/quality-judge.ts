// Draft quality scoring (issue #41, reworked by LOR-229).
//
// Before LOR-229 this module held only a rubric template and a band mapping;
// the number itself was whatever the drafting agent chose to report about
// its own output (`cli/src/commands/drafts.ts`'s old `qualityScore` input),
// with no gate behind it - self-graded homework, on a rubric (clarity,
// relevance, personalization, tone) that never measured the thing that
// actually loses the sale: reading as machine-written.
//
// The score is now computed here, in two parts that are never confused with
// each other:
//
//   - A deterministic component (`computeDeterministicQuality`), derived from
//     `shared/src/style-check.ts` and the operator's own measured voice
//     corpus (`shared/src/operator-voice-profile.ts` / LOR-227). No model
//     call, no configuration required, and reproducible: the same body
//     against the same corpus always scores the same. A non-zero style
//     finding count caps the result outright - it can never read as green,
//     regardless of anything else measured. An axis the corpus has not
//     earned an opinion on (too thin, or the candidate itself is too short
//     to read a register off) is excluded from the average, never treated as
//     a match or a miss - the same discipline `voice-metrics.ts` (LOR-44)
//     and `voice-profile.ts` (#571) already apply.
//   - An optional judged component (`judgeQuality`): a real, separate model
//     call reading the draft against `rubric_template` and returning its own
//     score and reason. Off unless an admin has explicitly configured a
//     model for the `quality_judge` function
//     (`shared/src/ai/model-functions.ts`) - this checks the raw stored
//     config, never `resolveFunctionModel`'s coded-default fallback, so an
//     unconfigured deployment never dials out on a path billed by draft
//     volume. Absent, not zero, when it does not run: a missing judge must
//     never drag the score down.
//
// `scoreDraftQuality` combines the two into what actually gets persisted:
// the judged score when one was made, else the deterministic one, always
// still subject to the style-finding cap. `qualityModel` records which kind
// of number it is - the literal string `DETERMINISTIC_QUALITY_MODEL` or the
// judge's real model id - so a caller (the Inbox badge) can always tell.
//
// 2026-09-11 (LOR-251): the deterministic component gained two more axes,
// echo and language match, measured against the post the draft answers
// rather than the operator's own corpus. A campaign draft never carried
// that text at all before this, so both axes were structurally dead outside
// the offline voice-eval harness - `createDrafts`
// (cli/src/commands/drafts.ts) now reads it off
// `sourceRef.sourceText`/`sourceRef.sourceComments`, clamped to the same
// MAX_POST_CHARS/MAX_THREAD_COMMENTS/MAX_COMMENT_CHARS/MAX_THREAD_CHARS
// ceilings the assist plane already enforces (`assist/suggest-prompt.ts`).
// The length axis now prefers the visible thread's median over the
// operator's own corpus median when a playbook supplied one - the same
// preference order `voice-metrics.ts`'s own header documents for
// `scoreCandidate`. Absent source text (a proactive post) leaves
// echo/languageMatch/thread-length `null`, the same refuse-rather-than-
// guess discipline the rest of this file already applies.
import { eq } from 'drizzle-orm';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import type { Db } from './db/client.js';
import { appConfig } from './db/schema.js';
import { loadModelFunctionConfig } from './ai/model-functions.js';
import { resolveOperatorVoiceProfile } from './operator-voice-profile.js';
import {
  measureOneText,
  AVOIDED_WORDS_MIN_WORDS,
  type RhythmProfile,
  type PunctuationProfile,
  type ShapeProfile,
  type VoiceMarkerProfile,
  type LexiconProfile,
} from './assist/voice-profile.js';
import {
  rhythmDistance,
  punctuationDistance,
  shapeDistance,
  voiceMarkersDistance,
  lexiconDistance,
  echoScore,
  type VoiceMetricsLanguage,
} from './voice-metrics.js';
import type { StyleFinding } from './style-check.js';

// The rubric shape, the default, the band mapping and the deterministic
// sentinel live in `quality-bands.ts` and are re-exported here so no
// server caller has to know that. They are separate because this module
// imports `ai`, `@ai-sdk/gateway` and the pg-backed voice profile, and two
// Svelte components need the band mapping: importing it from here dragged
// all of that into the browser bundle and broke the Inbox's hydration (see
// `quality-bands.ts`'s own header for the measurement).
export {
  DEFAULT_QUALITY_RUBRIC,
  DETERMINISTIC_QUALITY_MODEL,
  scoreBand,
  type QualityBand,
  type QualityRubric,
} from './quality-bands.js';
import {
  DEFAULT_QUALITY_RUBRIC,
  DETERMINISTIC_QUALITY_MODEL,
  type QualityRubric,
} from './quality-bands.js';

// The pre-LOR-229 default, kept only so `loadQualityRubric` can recognize a
// stored row that is really just the old default rather than a genuine
// customization (see its own comment below) - never used as a live rubric.
const LEGACY_DEFAULT_RUBRIC_TEMPLATE =
  'Score the following outreach draft from 0-100 on these axes (clarity, relevance, personalization, tone). Return JSON {"score": number, "reason": string}.';

export async function loadQualityRubric(db: Db): Promise<QualityRubric> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, 'quality_rubric'));
  if (!row) return { ...DEFAULT_QUALITY_RUBRIC };
  const v = row.value as Partial<QualityRubric>;
  const stored = typeof v.rubric_template === 'string' ? v.rubric_template : undefined;
  // A row already on file carrying the OLD default verbatim is not a real
  // customization to preserve - it's every deployment that never touched
  // the setting, migrated forward to the new wording rather than frozen on
  // a rubric that scored the wrong thing. Anything else stored is a real
  // choice and survives untouched.
  const rubric_template =
    stored && stored !== LEGACY_DEFAULT_RUBRIC_TEMPLATE
      ? stored
      : DEFAULT_QUALITY_RUBRIC.rubric_template;
  return {
    rubric_template,
    threshold_red:
      typeof v.threshold_red === 'number' ? v.threshold_red : DEFAULT_QUALITY_RUBRIC.threshold_red,
    threshold_green:
      typeof v.threshold_green === 'number'
        ? v.threshold_green
        : DEFAULT_QUALITY_RUBRIC.threshold_green,
  };
}

// ---------------------------------------------------------------------------
// The deterministic component.
// ---------------------------------------------------------------------------

/** The operator's own pooled voice profile, in the shape the per-axis
 * distance functions need - a subset of `OperatorVoiceProfileRow.evidence`
 * (`operator-voice-profile.ts`, LOR-227), read-only from here. */
export interface OperatorCorpusProfile {
  rhythm: RhythmProfile;
  punctuation: PunctuationProfile;
  shape: ShapeProfile;
  voiceMarkers: VoiceMarkerProfile;
  lexicon: LexiconProfile;
}

/** The operator's corpus profile, or `null` when it has not cleared
 * `MIN_ITEMS_TO_DERIVE` yet (`resolveOperatorVoiceProfile`'s own honest
 * gate) - never a default profile standing in for a measurement, the same
 * rule #571 applies everywhere else this data is read. */
export async function resolveOperatorCorpusProfile(
  db: Db,
  organizationId: number,
): Promise<OperatorCorpusProfile | null> {
  const resolved = await resolveOperatorVoiceProfile(db, organizationId);
  if (resolved.status !== 'measured' || !resolved.measured) return null;
  const { rhythm, punctuation, shape, voiceMarkers, lexicon } = resolved.measured.evidence;
  return { rhythm, punctuation, shape, voiceMarkers, lexicon };
}

export type QualityAxisScore = number | null;

export interface DeterministicQualityAxes {
  rhythm: QualityAxisScore;
  punctuation: QualityAxisScore;
  shape: QualityAxisScore;
  voiceMarkers: QualityAxisScore;
  lexicon: QualityAxisScore;
  /** Distance derived from `lengthRatio`: `min(1, abs(ratio - 1))`, the same
   * capped-at-1 idiom every other numeric axis in `voice-metrics.ts` uses. */
  length: QualityAxisScore;
  /** `voice-metrics.ts`'s `echoScore`, against the post this draft answers
   * (LOR-251) - `null` when there is no source post to compare against, or
   * the candidate has no content words of its own to measure. */
  echo: QualityAxisScore;
  /** `0` when the candidate answers in the source post's own language, `1`
   * when it does not, `null` when there is no source post or either side's
   * language could not be classified. Distance-shaped (0 = good) so it
   * folds into the same average as every other axis here; `languageMatch`
   * on `DeterministicQualityDetail` below carries the raw boolean. */
  languageMatch: QualityAxisScore;
}

export interface DeterministicQualityDetail {
  /** `null` only when literally nothing was measurable: no style findings
   * and no axis cleared its own floor (a thin or absent operator corpus,
   * and no source post to answer). Never a guessed number standing in for
   * "unmeasured". */
  score: number | null;
  styleFindingCount: number;
  distance: DeterministicQualityAxes;
  /** Candidate word count divided by the comparator named in
   * `lengthComparisonBasis` - `null` when neither comparator is available. */
  lengthRatio: number | null;
  /** Which comparator `lengthRatio` used: the visible thread's median word
   * count when a playbook supplied one (LOR-251, preferred - it is the
   * room the reply is actually read in), else the operator's own corpus
   * median item length, else `null` when neither is available. */
  lengthComparisonBasis: 'thread-median' | 'operator-corpus' | null;
  candidateWordCount: number;
  /** How many of the 8 axes above actually contributed to `score`. */
  measuredAxisCount: number;
  corpusMeasured: boolean;
  /** Whether a source post was supplied at all (LOR-251) - distinct from
   * `corpusMeasured`, since a proactive post has no source to answer and
   * that is a normal, honest outcome, not a thin corpus. */
  sourceMeasured: boolean;
  /** Raw form of `distance.languageMatch` - `null` when `sourceMeasured` is
   * false or either side's language could not be classified. */
  languageMatch: boolean | null;
  candidateLanguage: VoiceMetricsLanguage;
  /** `null` when `sourceMeasured` is false. */
  postLanguage: VoiceMetricsLanguage | null;
}

/** 3-line copy of `voice-metrics.ts`'s own private `median`, on purpose -
 * the same call that file's header already makes for its small numeric
 * helpers: not specific to either module, and not worth a new import
 * surface for three lines. */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * The deterministic half of a draft's quality score: style findings (a hard
 * cap, never averaged away), per-axis stylometric distance and length
 * against the operator's own measured voice corpus, and - when the draft
 * answers a source post - echo and language match against that post, plus
 * a length comparison against the visible thread when one was supplied.
 * Pure and synchronous - no model, no I/O - so it is reproducible across two
 * runs on the same inputs, and unit-testable without a database.
 */
export function computeDeterministicQuality(args: {
  body: string;
  styleFindings: StyleFinding[];
  corpus: OperatorCorpusProfile | null;
  rubric: QualityRubric;
  /** The post/story/status this draft answers (LOR-251) - absent or empty
   * for a proactive post, which has nothing to echo or match language
   * against. */
  post?: string | null;
  /** Word counts of the visible thread's other comments (LOR-251), when a
   * playbook supplied any - the length axis's preferred comparator over the
   * operator's own corpus median. */
  threadCommentWordCounts?: number[];
}): DeterministicQualityDetail {
  const { body, styleFindings, corpus, rubric, threadCommentWordCounts } = args;
  const post = args.post && args.post.trim() !== '' ? args.post : null;
  const candidateM = measureOneText(body);
  const postM = post !== null ? measureOneText(post) : null;

  // Rhythm/punctuation/shape/voiceMarkers all need the candidate to
  // individually clear register.ts's own floor - the same gate
  // `voice-metrics.ts`'s `distanceAxes` applies to a candidate-vs-reply
  // comparison, applied here to a candidate-vs-corpus one instead.
  const structuralMeasurable = corpus !== null && candidateM.register !== null;
  const lexiconMeasurable = corpus !== null && candidateM.wordCount >= AVOIDED_WORDS_MIN_WORDS;

  const languageMatch =
    postM !== null && candidateM.language !== 'unknown' && postM.language !== 'unknown'
      ? candidateM.language === postM.language
      : null;

  const distance: DeterministicQualityAxes = {
    rhythm: structuralMeasurable ? rhythmDistance(candidateM.rhythm, corpus.rhythm) : null,
    punctuation: structuralMeasurable
      ? punctuationDistance(candidateM.punctuation, corpus.punctuation)
      : null,
    shape: structuralMeasurable ? shapeDistance(candidateM.shape, corpus.shape) : null,
    voiceMarkers: structuralMeasurable
      ? voiceMarkersDistance(candidateM.voiceMarkers, corpus.voiceMarkers)
      : null,
    lexicon: lexiconMeasurable ? lexiconDistance(candidateM.lexicon, corpus!.lexicon) : null,
    length: null,
    echo: postM !== null ? echoScore(body, post!) : null,
    languageMatch: languageMatch === null ? null : languageMatch ? 0 : 1,
  };

  let lengthRatio: number | null = null;
  let lengthComparisonBasis: 'thread-median' | 'operator-corpus' | null = null;
  if (threadCommentWordCounts && threadCommentWordCounts.length > 0) {
    const basis = median(threadCommentWordCounts);
    if (basis > 0) {
      lengthRatio = Math.round((candidateM.wordCount / basis) * 100) / 100;
      lengthComparisonBasis = 'thread-median';
    }
  }
  if (lengthComparisonBasis === null && corpus !== null && corpus.rhythm.medianItemWords > 0) {
    lengthRatio = Math.round((candidateM.wordCount / corpus.rhythm.medianItemWords) * 100) / 100;
    lengthComparisonBasis = 'operator-corpus';
  }
  if (lengthRatio !== null) distance.length = Math.min(1, Math.abs(lengthRatio - 1));

  const measured = Object.values(distance).filter((d): d is number => d !== null);
  const axisScore =
    measured.length > 0
      ? 100 * (1 - measured.reduce((sum, v) => sum + v, 0) / measured.length)
      : null;

  let score = axisScore;
  if (styleFindings.length > 0) {
    // "Caps the score outright" (LOR-229): a finding can only ever pull the
    // score down toward - or below - just-under-green, never leave it
    // untouched. Applies even when no axis was otherwise measurable, so a
    // draft with real findings and a thin operator corpus still reports a
    // real, non-null, non-green number rather than "not measured".
    const cap = rubric.threshold_green - 1;
    score = score === null ? cap : Math.min(score, cap);
  }

  return {
    score: score === null ? null : Math.round(Math.max(0, Math.min(100, score)) * 100) / 100,
    styleFindingCount: styleFindings.length,
    distance,
    lengthRatio,
    lengthComparisonBasis,
    candidateWordCount: candidateM.wordCount,
    measuredAxisCount: measured.length,
    corpusMeasured: corpus !== null,
    sourceMeasured: postM !== null,
    languageMatch,
    candidateLanguage: candidateM.language,
    postLanguage: postM !== null ? postM.language : null,
  };
}

function describeDeterministic(d: DeterministicQualityDetail): string | null {
  if (d.score == null) return null;
  const parts: string[] = [];
  if (d.styleFindingCount > 0) {
    parts.push(
      `${d.styleFindingCount} style ${d.styleFindingCount === 1 ? 'finding' : 'findings'}`,
    );
  }
  if (d.lengthRatio != null) {
    const basisLabel =
      d.lengthComparisonBasis === 'thread-median'
        ? "the visible thread's length"
        : "the operator's typical length";
    parts.push(`${d.lengthRatio}x ${basisLabel}`);
  }
  if (d.distance.echo != null) {
    parts.push(`${Math.round(d.distance.echo * 100)}% echo of the source post`);
  }
  if (d.languageMatch === false) {
    parts.push('answered in a different language than the source post');
  }
  const corpusAxisCount = [
    d.distance.rhythm,
    d.distance.punctuation,
    d.distance.shape,
    d.distance.voiceMarkers,
    d.distance.lexicon,
  ].filter((v) => v !== null).length;
  if (corpusAxisCount > 0) {
    parts.push(
      `${corpusAxisCount} voice ${corpusAxisCount === 1 ? 'axis' : 'axes'} measured against their own writing`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : 'No comparable operator voice profile yet.';
}

// ---------------------------------------------------------------------------
// The optional judged component.
// ---------------------------------------------------------------------------

export interface JudgedQuality {
  score: number;
  reason: string;
  /** The Gateway model id that produced this - what an admin configured for
   * `quality_judge`, verbatim, so a caller can show whose opinion this is. */
  model: string;
}

const JUDGE_PROMPT_MAX_BODY_CHARS = 4000;

function buildJudgePrompt(rubric: QualityRubric, body: string, title?: string | null): string {
  const parts = [rubric.rubric_template];
  if (title) parts.push(`Title: ${title}`);
  parts.push(`Draft:\n${body.slice(0, JUDGE_PROMPT_MAX_BODY_CHARS)}`);
  return parts.join('\n\n');
}

const JudgeResponseSchema = z.object({ score: z.number(), reason: z.string() });

function parseJudgeResponse(text: string): { score: number; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JudgeResponseSchema.parse(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

/**
 * A real, separate model call judging one draft, or `null` when it did not
 * run - absent, never zero. Gated on the raw `model_functions` config
 * (`config.quality_judge`) rather than `resolveFunctionModel`'s
 * coded-default fallback: this must be OFF unless a deployment explicitly
 * opted in, since it is a per-draft Gateway call on a path billed by draft
 * volume. Never throws: a bad response, a missing Gateway key, or a
 * transient provider error all read as "no judge", exactly like a self-
 * report used to be lenient about a bad score - one judge failure must
 * never fail the draft batch it is scoring.
 */
export async function judgeQuality(
  db: Db,
  args: { body: string; title?: string | null; rubric: QualityRubric },
): Promise<JudgedQuality | null> {
  const config = await loadModelFunctionConfig(db);
  const modelId = config.quality_judge;
  if (!modelId) return null;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) return null;
  try {
    const gateway = createGateway({ apiKey });
    const result = await generateText({
      model: gateway(modelId),
      messages: [{ role: 'user', content: buildJudgePrompt(args.rubric, args.body, args.title) }],
    });
    const parsed = parseJudgeResponse(result.text);
    if (!parsed || !Number.isFinite(parsed.score)) return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(parsed.score))),
      reason: parsed.reason.slice(0, 300),
      model: modelId,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Combining the two into what gets persisted.
// ---------------------------------------------------------------------------

/** `drafts.quality_model`'s sentinel for "computed, not judged" - as real a
 * value as an actual Gateway model id, never confused with one (no `/` in
 * it, unlike every Gateway id). */

export interface DraftQualityResult {
  qualityScore: number | null;
  qualityReason: string | null;
  qualityModel: string | null;
  /** Persisted verbatim into the draft's `metadata.qualityDetail` - the
   * per-axis detail neither `qualityScore` nor `qualityReason` alone carry,
   * and what lets a caller (or a test) tell a deterministic-only result from
   * a judged one without re-deriving anything. */
  qualityDetail: { deterministic: DeterministicQualityDetail; judged: JudgedQuality | null };
}

/**
 * Scores one draft body: the deterministic component always, the judged
 * component when configured. The judged score is what gets shown when
 * present (a real, separate opinion is worth more than a computed proxy for
 * it), but the style-finding cap still applies on top of it - "a draft with
 * style findings can never score green" holds regardless of whether a judge
 * ran.
 */
export async function scoreDraftQuality(
  db: Db,
  args: {
    body: string;
    title?: string | null;
    styleFindings: StyleFinding[];
    corpus: OperatorCorpusProfile | null;
    rubric: QualityRubric;
    post?: string | null;
    threadCommentWordCounts?: number[];
  },
): Promise<DraftQualityResult> {
  const deterministic = computeDeterministicQuality({
    body: args.body,
    styleFindings: args.styleFindings,
    corpus: args.corpus,
    rubric: args.rubric,
    post: args.post,
    threadCommentWordCounts: args.threadCommentWordCounts,
  });
  const judged = await judgeQuality(db, {
    body: args.body,
    title: args.title,
    rubric: args.rubric,
  });

  let qualityScore = judged ? judged.score : deterministic.score;
  if (args.styleFindings.length > 0) {
    const cap = args.rubric.threshold_green - 1;
    qualityScore = qualityScore == null ? cap : Math.min(qualityScore, cap);
  }
  // `drafts.quality_score` is a `smallint` column. `judged.score` is
  // already a whole number (`judgeQuality` rounds it); the deterministic
  // score keeps 2-decimal precision inside `qualityDetail.deterministic`
  // for anything that wants the finer number, but LOR-251 is the first
  // caller that regularly reaches this function with echo/language-match
  // in the axis average and no style-finding cap to round it away for
  // free (`computeDeterministicQuality`'s own axes needed a measured
  // operator corpus before that; a source post alone is now enough) - a
  // fractional value here fails the write outright rather than truncating,
  // so round once, at the boundary, rather than changing what
  // `deterministic.score` itself reports.
  qualityScore = qualityScore == null ? null : Math.round(qualityScore);

  const qualityReason = judged ? judged.reason : describeDeterministic(deterministic);
  const qualityModel = judged
    ? judged.model
    : qualityScore != null
      ? DETERMINISTIC_QUALITY_MODEL
      : null;

  return {
    qualityScore,
    qualityReason,
    qualityModel,
    qualityDetail: { deterministic, judged },
  };
}
