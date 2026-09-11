// shared/src/voice-metrics.ts (LOR-44)
//
// "It sounds like him" is the product claim that decides whether Pitchbox is
// worth anything, and this is the load-bearing half of proving it rather
// than asserting it: a pure, synchronous, model-free module that turns one
// piece of text into a comparable measurement, and turns two of them - a
// candidate reply and the operator's own real reply to the same post - into
// a distance. Every other issue in this project reads this module's output;
// nothing in this file calls a model, reads a file, or reaches a database.
//
// It reuses what already exists rather than inventing a second measurement:
// `assist/voice-profile.ts`'s `measureOneText` (rhythm, punctuation, shape,
// voice markers, lexicon, language - the same axes `measureVoiceCorpus`
// derives from a corpus, read off one string instead) and `style-check.ts`'s
// `checkStyle` (the tell detector). What this file adds is the comparisons a
// single measurement cannot make on its own:
//
//   - style findings: `checkStyle`'s own count and rule ids against the
//     candidate. The target is zero; a non-zero count is a hard fail of the
//     case, not a score component to average away.
//   - stylometric distance between the candidate and the operator's own real
//     reply, one number per axis rather than folded into a single score -
//     which axis is wrong is the actionable part.
//   - length ratio: the candidate's word count against the best comparator
//     the case can supply - the thread's median visible comment when known,
//     else the operator's own real reply's length, which every harvested
//     case can always supply. This axis moves first: a corpus of real
//     replies running seven words median against a hundred-plus-word
//     "professional" default is most of why a suggestion reads as
//     machine-written, and it is the one difference a human notices without
//     reading closely.
//   - echo: how much of the candidate is made of words already in the post -
//     a suggestion that quotes the post back at its author is the single
//     most recognisable machine tell in the category.
//   - language match: whether the candidate answers in the post's own
//     language, via `voice-profile.ts`'s own classifier.
//
// Several of these are not measurable on every input, and a short candidate
// or a short real reply (the corpus this project actually cares about runs a
// median of seven words) is the common case, not the edge case. An
// unmeasurable axis is reported as `null`, never as 0 (a false "identical")
// or 1 (a false "as different as possible") - the same refuse-rather-than-
// guess discipline `register.ts` and `voice-profile.ts` already apply to a
// corpus too small to describe.

import {
  measureOneText,
  classifyLanguage,
  AVOIDED_WORDS_MIN_WORDS,
  type OneTextMeasurement,
  type RhythmProfile,
  type PunctuationProfile,
  type ShapeProfile,
  type VoiceMarkerProfile,
  type LexiconProfile,
} from './assist/voice-profile.js';
import { checkStyle, type StyleFinding } from './style-check.js';

export type VoiceMetricsLanguage = 'en' | 'it' | 'unknown';

/** A per-axis (or per-comparison) result: a number in `[0, 1]` (0 =
 * identical, 1 = as different as the axis's own scale considers
 * meaningful), or `null` when one or both sides did not clear that axis's
 * own measurability floor - see the module header. */
export type AxisScore = number | null;

export interface AxisDistances {
  rhythm: AxisScore;
  punctuation: AxisScore;
  shape: AxisScore;
  voiceMarkers: AxisScore;
  lexicon: AxisScore;
}

export type LengthComparisonBasis = 'thread-median' | 'actual-reply' | null;

export interface VoiceCandidateScore {
  /** `checkStyle`'s own findings against the candidate, verbatim - zero is
   * the target, and a non-zero count is this case's hard fail. */
  styleFindings: StyleFinding[];
  /** Per-axis stylometric distance between the candidate and the operator's
   * own real reply to the same post. */
  distance: AxisDistances;
  /** Candidate word count divided by the comparison length named in
   * `lengthComparisonBasis`. Above 1 means the candidate runs longer than
   * the room (or than the real reply); `null` when there is nothing to
   * compare against at all. */
  lengthRatio: AxisScore;
  lengthComparisonBasis: LengthComparisonBasis;
  /** Fraction of the candidate's own content words (length-4-plus, a coarse
   * stopword floor rather than a dictionary) that already appear in the
   * post - 0 means no shared wording, 1 means the candidate is built
   * entirely out of the post's own words. `null` when the candidate has no
   * content words of its own to measure (e.g. a bare emoji reply). */
  echo: AxisScore;
  /** Whether the candidate's language matches the post's, via
   * `voice-profile.ts`'s own classifier. `null` when either side's language
   * could not be classified - a short reply is the common case here, not
   * the edge case. */
  languageMatch: boolean | null;
  candidateLanguage: VoiceMetricsLanguage;
  postLanguage: VoiceMetricsLanguage;
  candidateWordCount: number;
}

export interface ScoreCandidateArgs {
  candidate: string;
  /** The post the candidate answers. */
  post: string;
  /** The operator's own real reply to the same post - `null` only for a
   * genuine "the right answer was silence" case, in which every axis that
   * needs a real reply to compare against is `null` rather than guessed. */
  actualReply: string | null;
  /** Word counts of other visible comments under the post, when known -
   * feeds the length-ratio axis's ideal comparator, the room's median.
   * Absent falls back to `actualReply`'s own length, the one comparator a
   * corpus of real replies (rather than captured threads) can always
   * supply. */
  threadCommentWordCounts?: number[];
}

// ---------------------------------------------------------------------------
// Small local helpers. Kept local rather than shared with voice-profile.ts's
// own (private) copies of the same shapes - none of this is specific to
// voice measurement, the same call voice-profile.ts's own header makes for
// its small numeric helpers.
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Normalizes a raw difference by a per-field scale (a rough sense of "how
 * big a gap on this field is a lot"), capped at 1 so no single field can
 * make the axis average look worse than "as different as this axis gets" -
 * the scales are chosen to be generous, not tuned to any one corpus. */
function numDist(a: number, b: number, scale: number): number {
  return Math.min(1, Math.abs(a - b) / scale);
}

function boolDist(a: boolean, b: boolean): number {
  return a === b ? 0 : 1;
}

function setDistance(a: string[], b: string[]): number {
  const as = new Set(a);
  const bs = new Set(b);
  if (as.size === 0 && bs.size === 0) return 0;
  let intersection = 0;
  for (const x of as) if (bs.has(x)) intersection += 1;
  const union = new Set([...as, ...bs]).size;
  return union === 0 ? 0 : round2(1 - intersection / union);
}

/** Exported (LOR-229) so a caller comparing a candidate against something
 * other than a single real reply - the operator's own pooled corpus
 * profile, which shares this exact per-axis shape - can reuse this math
 * instead of a second copy of it. `distanceAxes` below is still the one
 * candidate-vs-real-reply entry point `scoreCandidate` uses. */
export function rhythmDistance(a: RhythmProfile, b: RhythmProfile): number {
  return round2(
    mean([
      numDist(a.medianSentenceWords, b.medianSentenceWords, 20),
      numDist(a.sentenceWordsSpread, b.sentenceWordsSpread, 10),
      numDist(a.medianParagraphWords, b.medianParagraphWords, 30),
      numDist(a.fragmentRatio, b.fragmentRatio, 1),
      numDist(a.shortOpeningRatio, b.shortOpeningRatio, 1),
    ]),
  );
}

export function punctuationDistance(a: PunctuationProfile, b: PunctuationProfile): number {
  return round2(
    mean([
      numDist(a.commasPer100Words, b.commasPer100Words, 10),
      numDist(a.colonsPer100Words, b.colonsPer100Words, 5),
      numDist(a.parenthesesPer100Words, b.parenthesesPer100Words, 5),
      numDist(a.dashesPer100Words, b.dashesPer100Words, 5),
      numDist(a.questionMarksPer100Words, b.questionMarksPer100Words, 5),
      numDist(a.exclamationMarksPer100Words, b.exclamationMarksPer100Words, 5),
      numDist(a.ellipsesPer100Words, b.ellipsesPer100Words, 5),
      boolDist(a.capitalizesOpenings, b.capitalizesOpenings),
      boolDist(a.lowercasesAfterColon, b.lowercasesAfterColon),
    ]),
  );
}

export function shapeDistance(a: ShapeProfile, b: ShapeProfile): number {
  // emoji/hashtags are deliberately not compared here: measureOneText always
  // computes them over a one-item list, and voice-profile.ts's own
  // MIN_PHRASE_REPEATS floor (2 separate items) means a single text can
  // never populate either array - comparing two always-empty lists would
  // report a free, meaningless "identical" rather than measuring anything.
  return round2(
    mean([
      numDist(a.lineBreaksPerParagraph, b.lineBreaksPerParagraph, 3),
      boolDist(a.usesLists, b.usesLists),
      a.ending === b.ending ? 0 : 1,
    ]),
  );
}

export function voiceMarkersDistance(a: VoiceMarkerProfile, b: VoiceMarkerProfile): number {
  return round2(
    mean([
      numDist(a.firstPersonPer100Words, b.firstPersonPer100Words, 10),
      numDist(a.secondPersonPer100Words, b.secondPersonPer100Words, 10),
      numDist(a.hedgesPer100Words, b.hedgesPer100Words, 5),
      numDist(a.certaintyPer100Words, b.certaintyPer100Words, 5),
      numDist(a.imperativeRatio, b.imperativeRatio, 1),
    ]),
  );
}

export function lexiconDistance(a: LexiconProfile, b: LexiconProfile): number {
  return setDistance(a.avoidedWords, b.avoidedWords);
}

/** Rhythm/punctuation/shape/voice-markers all need both sides to individually
 * clear register.ts's own MIN_WORDS_TO_DESCRIBE floor - `measureOneText`
 * already carries that answer as `register: PostRegister | null`, so this
 * reads it rather than re-deriving a second floor. */
function distanceAxes(
  candidate: OneTextMeasurement,
  reply: OneTextMeasurement | null,
): AxisDistances {
  const measurable = reply !== null && candidate.register !== null && reply.register !== null;
  return {
    rhythm: measurable ? rhythmDistance(candidate.rhythm, reply.rhythm) : null,
    punctuation: measurable ? punctuationDistance(candidate.punctuation, reply.punctuation) : null,
    shape: measurable ? shapeDistance(candidate.shape, reply.shape) : null,
    voiceMarkers: measurable
      ? voiceMarkersDistance(candidate.voiceMarkers, reply.voiceMarkers)
      : null,
    lexicon:
      reply !== null &&
      candidate.wordCount >= AVOIDED_WORDS_MIN_WORDS &&
      reply.wordCount >= AVOIDED_WORDS_MIN_WORDS
        ? lexiconDistance(candidate.lexicon, reply.lexicon)
        : null,
  };
}

/** Below this length a word is almost certainly a function word ("the",
 * "che", "and"...) rather than content - a coarse floor rather than a
 * bilingual stopword dictionary, the same tradeoff `voice-profile.ts`'s own
 * MIN_WORD_LENGTH makes for reused vocabulary. */
const ECHO_MIN_WORD_LENGTH = 4;

function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length >= ECHO_MIN_WORD_LENGTH);
  return new Set(words);
}

/**
 * Scores one candidate reply against the post it answers and the operator's
 * own real reply to that same post. Pure and synchronous - no model, no I/O.
 */
export function scoreCandidate(args: ScoreCandidateArgs): VoiceCandidateScore {
  const { candidate, post, actualReply, threadCommentWordCounts } = args;

  const candidateM = measureOneText(candidate);
  const postM = measureOneText(post);
  const replyM = actualReply != null ? measureOneText(actualReply) : null;

  let lengthRatio: AxisScore = null;
  let lengthComparisonBasis: LengthComparisonBasis = null;
  if (threadCommentWordCounts && threadCommentWordCounts.length > 0) {
    const basis = median(threadCommentWordCounts);
    if (basis > 0) {
      lengthRatio = round2(candidateM.wordCount / basis);
      lengthComparisonBasis = 'thread-median';
    }
  } else if (replyM !== null && replyM.wordCount > 0) {
    lengthRatio = round2(candidateM.wordCount / replyM.wordCount);
    lengthComparisonBasis = 'actual-reply';
  }

  const candidateContentWords = contentWords(candidate);
  const postContentWords = contentWords(post);
  const echo: AxisScore =
    candidateContentWords.size > 0
      ? round2(
          [...candidateContentWords].filter((w) => postContentWords.has(w)).length /
            candidateContentWords.size,
        )
      : null;

  const languageMatch =
    candidateM.language !== 'unknown' && postM.language !== 'unknown'
      ? candidateM.language === postM.language
      : null;

  return {
    styleFindings: checkStyle(candidate),
    distance: distanceAxes(candidateM, replyM),
    lengthRatio,
    lengthComparisonBasis,
    echo,
    languageMatch,
    candidateLanguage: candidateM.language,
    postLanguage: postM.language,
    candidateWordCount: candidateM.wordCount,
  };
}

/** Re-exported so a caller can classify a language without importing
 * voice-profile.ts directly for it. */
export { classifyLanguage };
