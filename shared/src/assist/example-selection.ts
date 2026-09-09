// shared/src/assist/example-selection.ts
//
// #578: which few-shot examples (suggest-prompt.ts's own MAX_EXAMPLES)
// belong in a suggestion's prompt. Before this, `buildSuggestionPrompt`
// just took the first `MAX_EXAMPLES` of whatever array the caller passed -
// in practice, active templates in `templates.createdAt` order, so the
// examples were three arbitrary samples rather than three relevant ones.
// "His comment on a hiring post and his comment on a database benchmark are
// different registers, and the useful example is the one from the same
// room" - three samples from the wrong room teach rhythm and nothing about
// how he writes about *this*.
//
// Deliberately not a model call, for the same three reasons voice-profile.ts
// gives (#570): nondeterminism, latency on a path a human is watching (the
// suggest endpoint already spends 10-14s before its first token, #360), and
// no way to unit-test a choice a model could make five different ways.
//
// Lexical overlap - the post's own significant vocabulary against each
// candidate's - is the whole ranking signal, on purpose. A structural
// signal (register.ts's thirteen boolean traits: first-person,
// contractions, list-layout, ...) was tried and dropped during development:
// two completely unrelated posts routinely share one or two of those
// traits by chance (both first-person, say, which is nearly every LinkedIn
// post), and blending that in read as false topical closeness for a pair
// of texts about nothing alike. That is the same "a corpus too small to
// say something honest about says nothing" discipline voice-profile.ts
// already applies (MIN_ITEMS_TO_DERIVE, TRAIT_DOMINANCE_RATIO) - applied
// here to a signal too coarse to say something honest about a single pair
// of texts. Register traits describe *how* something is written; this
// module is answering a question about *what it is about*, and only shared
// vocabulary actually answers that.
//
// Two disciplines on top of the ranking itself:
//
// - Diversity. The highest-scoring candidates are often near-paraphrases of
//   each other - an operator who wrote four similar replies to four similar
//   posts. Taking the top three by score alone would carry three
//   restatements of the same reply, which teaches the model one thing three
//   times rather than three things once. A candidate is skipped once it is
//   a near-duplicate (DUPLICATE_SIMILARITY_THRESHOLD) of one already picked,
//   even though the skipped one scored higher against the post than a more
//   varied candidate ranked below it - the same reason `topRepeatedPhrases`
//   in voice-profile.ts keeps only the first real rendering of a repeated
//   phrase rather than every occurrence.
// - A floor. MIN_SIMILARITY_SCORE is the line between "about the same
//   subject" and "shares a word or two by coincidence, the way almost any
//   pair of posts does." When nothing in the corpus clears it, forcing a
//   weak match into the prompt would teach the wrong register - so the
//   selection falls back to recency instead, the old behaviour, and says so
//   in `mode` and in every returned example's `reason`, the same
//   never-present-a-default-as-measured discipline
//   `resolveVoiceProfile`/`resolveOperatorVoiceProfile` (#571,
//   operator-voice-profile.ts) apply to a voice profile with too thin a
//   corpus to measure.

/** One example candidate as the DB actually stores it - enough to rank,
 * dedupe and fall back to recency without a second round trip. */
export interface ExampleCandidate {
  id: number;
  title: string;
  body: string;
  createdAt: Date;
}

export type ExampleSelectionMode = 'similarity' | 'recency';

export interface SelectedExample {
  id: number;
  title: string;
  body: string;
  /** Lexical-overlap score against the post, 0-1, rounded. Kept even for a
   * `recency`-mode pick (where it never cleared MIN_SIMILARITY_SCORE) so a
   * caller can render the actual number rather than trusting `mode` blind. */
  score: number;
  /** Why this one was picked - names the shared vocabulary for a
   * `similarity` pick, or says outright that nothing was close enough for a
   * `recency` one. #578's whole complaint about the old behaviour was that
   * nobody could say why three examples were chosen; this is the answer. */
  reason: string;
}

export interface ExampleSelection {
  mode: ExampleSelectionMode;
  examples: SelectedExample[];
}

/** Below this many characters a word carries no topic signal on its own -
 * mirrors voice-profile.ts's own MIN_WORD_LENGTH and tools.ts's
 * `significantWords`, the same tradeoff for the same reason (and it drops
 * "p99"/"sql"-style short technical tokens on both sides equally, so it
 * never favours one candidate over another). */
const MIN_WORD_LENGTH = 4;

/**
 * Below this lexical-overlap score, a candidate is not "about the same
 * subject" - it is the kind of one-or-two-shared-word overlap almost any
 * pair of LinkedIn-length posts has by coincidence. Calibrated against a
 * corpus of genuinely on-topic vs genuinely unrelated fixtures: unrelated
 * pairs scored 0-0.07, pairs actually about the same subject scored 0.28
 * and up (shared-tests/assist-example-selection.test.ts pins both ends).
 */
export const MIN_SIMILARITY_SCORE = 0.12;

/**
 * Above this candidate-to-candidate overlap, two examples are close enough
 * to teach the model the same thing twice - the "four similar replies"
 * failure mode this module exists to avoid. Calibrated the same way:
 * genuine paraphrases of one idea scored 0.6-0.9 against each other in the
 * calibration fixtures, two pieces merely on the same subject scored well
 * under 0.4.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.55;

// English and Italian - the same split every other lexical helper in this
// module carries (voice-profile.ts's STOPWORDS, tools.ts's
// PRIOR_TAKES_STOPWORDS), for the same reason: Lorenzo's own feed and his
// own writing are both half Italian. Not exhaustive on purpose - it only
// has to keep the handful of function words each language leans on out of
// a topic match, not classify the language.
const STOPWORDS: Record<string, true> = {
  the: true, and: true, for: true, with: true, that: true, this: true,
  have: true, from: true, about: true, your: true, you: true, are: true,
  was: true, were: true, been: true, they: true, their: true, what: true,
  when: true, where: true, which: true, into: true, over: true, than: true,
  then: true, also: true, just: true, like: true, more: true, some: true,
  after: true, once: true, week: true, weeks: true, month: true, months: true,
  della: true, delle: true, degli: true, questo: true, questa: true,
  queste: true, questi: true, anche: true, come: true, sono: true,
  stato: true, stati: true, state: true, perche: true, quando: true,
  dove: true, quale: true, quali: true,
}; // prettier-ignore

function significantWordSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const set = new Set<string>();
  for (const word of words) {
    if (word.length < MIN_WORD_LENGTH || STOPWORDS[word]) continue;
    set.add(word);
  }
  return set;
}

/** Jaccard similarity: shared words over the union, 0-1. Symmetric, and the
 * intersection itself is the "reason" a caller can show back to a human -
 * unlike a raw shared-word count, it does not reward a candidate for merely
 * being longer than the post. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
const RECENCY_FALLBACK_REASON =
  'Nothing in the corpus is topically close to this post, so this is a recent example instead.';

function similarityReason(sharedWords: string[], score: number): string {
  if (sharedWords.length === 0) {
    return `Best available match on this subject (word overlap ${score.toFixed(2)}).`;
  }
  const named = sharedWords.slice(0, 4).map((w) => `"${w}"`);
  return `Shares ${named.join(', ')} with the post.`;
}

type ScoredCandidate = {
  candidate: ExampleCandidate;
  words: Set<string>;
  sharedWords: string[];
  score: number;
};

/** Deterministic tie-break shared by both rankings below: score (when it
 * applies) first, then the more recent one, then the lower id - so two
 * candidates that tie on everything a human would look at still resolve the
 * same way on every call rather than depending on array insertion order. */
function byScoreThenRecency(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  return byRecencyThenId(a, b);
}

function byRecencyThenId(a: ScoredCandidate, b: ScoredCandidate): number {
  const delta = b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime();
  if (delta !== 0) return delta;
  return a.candidate.id - b.candidate.id;
}

/**
 * Selects up to `max` examples for `post` out of `candidates` - the
 * MAX_EXAMPLES ceiling still lives in suggest-prompt.ts, this only decides
 * which ones. Pure, synchronous, no model, no I/O: the same post and the
 * same candidate list always produce the same selection, in the same order,
 * with the same stated reasons.
 */
export function selectExamples(
  post: { text: string },
  candidates: ExampleCandidate[],
  max: number,
): ExampleSelection {
  const postWords = significantWordSet(post.text);

  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const words = significantWordSet(`${candidate.title} ${candidate.body}`);
    const sharedWords = [...words].filter((w) => postWords.has(w)).sort();
    return { candidate, words, sharedWords, score: jaccard(postWords, words) };
  });

  const byRelevance = [...scored].sort(byScoreThenRecency);
  const topScore = byRelevance[0]?.score ?? 0;

  if (topScore < MIN_SIMILARITY_SCORE) {
    const byRecency = [...scored].sort(byRecencyThenId);
    return {
      mode: 'recency',
      examples: byRecency.slice(0, max).map((s) => ({
        id: s.candidate.id,
        title: s.candidate.title,
        body: s.candidate.body,
        score: Math.round(s.score * 100) / 100,
        reason: RECENCY_FALLBACK_REASON,
      })),
    };
  }

  const picked: ScoredCandidate[] = [];
  for (const entry of byRelevance) {
    if (picked.length >= max) break;
    if (entry.score < MIN_SIMILARITY_SCORE) continue;
    const isNearDuplicate = picked.some(
      (p) => jaccard(p.words, entry.words) >= DUPLICATE_SIMILARITY_THRESHOLD,
    );
    if (isNearDuplicate) continue;
    picked.push(entry);
  }

  return {
    mode: 'similarity',
    examples: picked.map((s) => ({
      id: s.candidate.id,
      title: s.candidate.title,
      body: s.candidate.body,
      score: Math.round(s.score * 100) / 100,
      reason: similarityReason(s.sharedWords, s.score),
    })),
  };
}
