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
} from './voice-metrics.js';
import type { StyleFinding } from './style-check.js';

export interface QualityRubric {
  rubric_template: string;
  threshold_red: number;
  threshold_green: number;
}

// The pre-LOR-229 default, kept only so `loadQualityRubric` can recognize a
// stored row that is really just the old default rather than a genuine
// customization (see its own comment below) - never used as a live rubric.
const LEGACY_DEFAULT_RUBRIC_TEMPLATE =
  'Score the following outreach draft from 0-100 on these axes (clarity, relevance, personalization, tone). Return JSON {"score": number, "reason": string}.';

export const DEFAULT_QUALITY_RUBRIC: QualityRubric = {
  rubric_template:
    'Score this draft from 0-100 on whether it reads as something a real person actually wrote and sent, not a generic AI reply. Weigh: would a reader take this for a person rather than a bot; does it say one concrete thing rather than vague encouragement; does it answer this specific post rather than any post on the same subject; and is it roughly the length a real reply in this room runs, not a small essay. Return JSON {"score": number, "reason": string}.',
  threshold_red: 40,
  threshold_green: 75,
};

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

// Map a numeric score to a UI band given the configured rubric thresholds.
export function scoreBand(
  score: number | null | undefined,
  rubric: QualityRubric,
): 'red' | 'amber' | 'green' | 'none' {
  if (score == null) return 'none';
  if (score < rubric.threshold_red) return 'red';
  if (score >= rubric.threshold_green) return 'green';
  return 'amber';
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
}

export interface DeterministicQualityDetail {
  /** `null` only when literally nothing was measurable: no style findings
   * and no axis cleared its own floor (a thin or absent operator corpus).
   * Never a guessed number standing in for "unmeasured". */
  score: number | null;
  styleFindingCount: number;
  distance: DeterministicQualityAxes;
  /** Candidate word count divided by the operator's own corpus median item
   * length (`rhythm.medianItemWords`, LOR-232) - `null` when the corpus is
   * not measured or has never derived a length. */
  lengthRatio: number | null;
  candidateWordCount: number;
  /** How many of the 6 axes above actually contributed to `score`. */
  measuredAxisCount: number;
  corpusMeasured: boolean;
}

/**
 * The deterministic half of a draft's quality score: style findings (a hard
 * cap, never averaged away) plus per-axis stylometric distance and length
 * against the operator's own measured voice corpus. Pure and synchronous -
 * no model, no I/O - so it is reproducible across two runs on the same body
 * and the same corpus, and unit-testable without a database.
 */
export function computeDeterministicQuality(args: {
  body: string;
  styleFindings: StyleFinding[];
  corpus: OperatorCorpusProfile | null;
  rubric: QualityRubric;
}): DeterministicQualityDetail {
  const { body, styleFindings, corpus, rubric } = args;
  const candidateM = measureOneText(body);

  // Rhythm/punctuation/shape/voiceMarkers all need the candidate to
  // individually clear register.ts's own floor - the same gate
  // `voice-metrics.ts`'s `distanceAxes` applies to a candidate-vs-reply
  // comparison, applied here to a candidate-vs-corpus one instead.
  const structuralMeasurable = corpus !== null && candidateM.register !== null;
  const lexiconMeasurable = corpus !== null && candidateM.wordCount >= AVOIDED_WORDS_MIN_WORDS;

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
  };

  let lengthRatio: number | null = null;
  if (corpus !== null && corpus.rhythm.medianItemWords > 0) {
    lengthRatio = Math.round((candidateM.wordCount / corpus.rhythm.medianItemWords) * 100) / 100;
    distance.length = Math.min(1, Math.abs(lengthRatio - 1));
  }

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
    candidateWordCount: candidateM.wordCount,
    measuredAxisCount: measured.length,
    corpusMeasured: corpus !== null,
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
    parts.push(`${d.lengthRatio}x the operator's typical length`);
  }
  if (d.measuredAxisCount > 0) {
    parts.push(
      `${d.measuredAxisCount} voice ${d.measuredAxisCount === 1 ? 'axis' : 'axes'} measured against their own writing`,
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
export const DETERMINISTIC_QUALITY_MODEL = 'deterministic';

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
  },
): Promise<DraftQualityResult> {
  const deterministic = computeDeterministicQuality({
    body: args.body,
    styleFindings: args.styleFindings,
    corpus: args.corpus,
    rubric: args.rubric,
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
