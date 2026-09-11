// shared/src/assist/voice-profile.ts
//
// The operator's own voice, derived from what they have actually written
// (#407) - the other half of #406's per-post register measurement. That one
// reads a single post someone else wrote; this one reads a corpus of the
// operator's own voice samples, sent messages, sent drafts and templates,
// and reports what genuinely repeats across them.
//
// Deliberately not a model call, for the same three reasons register.ts
// gives: nondeterminism, latency on a path a human is watching (the suggest
// endpoint already spends 10-14s before its first token, #360), and no way
// to unit-test a summary a model could phrase five different ways. Every
// property below is countable - a per-item register trait, whether an
// opening phrase or a word actually repeats across separate pieces of
// writing - and a corpus too small to say something honest about says
// nothing, the same rule register.ts's MIN_WORDS_TO_DESCRIBE follows:
// describing three posts as having a "recurring" anything is inventing a
// pattern out of noise.
//
// 2026-09-09 (#570): extended past openings/closings/reused words into six
// more axes - rhythm, punctuation, shape, voice markers, lexicon and
// language split - because that quartet was a fraction of what makes
// writing recognisably somebody's. Every new axis follows the same
// discipline: a countable property, a named floor, and an empty result
// rather than a guess when the corpus has not earned an opinion. #571's
// human defaults (`assist/voice-defaults.ts`) are a separate, deliberately
// different-shaped object for exactly this reason - a default is a rule to
// follow, not a number this module claims to have measured.

import { readPostRegister, type PostRegister, type RegisterTrait } from './register.js';

export type VoiceCorpusItemKind = 'voice_sample' | 'message' | 'draft' | 'template';

const VOICE_CORPUS_ITEM_KINDS: readonly VoiceCorpusItemKind[] = [
  'voice_sample',
  'message',
  'draft',
  'template',
];

/** The genre of a piece of writing - a post, a top-level comment or a
 * reply to a comment (LOR-223). Only `voice_sample` items carry one today
 * (`operator_voice_samples.genre`): a message, a sent draft or a template
 * is outreach, not a LinkedIn post or comment, so it has no genre of this
 * kind and is left out of the per-genre split below, while still counting
 * toward the pooled corpus `measureVoiceCorpus` already produces. A post
 * and a comment are not the same voice at a different length - Lorenzo's
 * own corpus runs a median 122 words per post against a median 7 words per
 * comment, sixteen of twenty-seven comments under ten words - so pooling
 * them is what makes a comment suggestion come out as a paragraph. */
export type VoiceCorpusItemGenre = 'post' | 'comment' | 'reply';

export const VOICE_CORPUS_ITEM_GENRES: readonly VoiceCorpusItemGenre[] = [
  'post',
  'comment',
  'reply',
];

/** One piece of the operator's own writing, tagged with where it came from
 * and its id, so the caller can turn a measurement back into evidence
 * (which ids it was derived from) without re-deriving it. `genre` is
 * absent for a corpus item with no genre of its own (message, draft,
 * template) - see `VoiceCorpusItemGenre`'s own comment. */
export type VoiceCorpusItem = {
  id: number;
  kind: VoiceCorpusItemKind;
  genre?: VoiceCorpusItemGenre;
  text: string;
};

/** Below this many usable pieces of writing, nothing here is trustworthy:
 * two posts sharing an opening word is coincidence, not a habit. */
export const MIN_ITEMS_TO_DERIVE = 3;

/** A register trait, or any other boolean habit below, counts as habitual
 * rather than incidental only once it shows up in a clear majority of the
 * measurable corpus. */
const TRAIT_DOMINANCE_RATIO = 0.6;

/** How many words of an opening are compared when looking for a repeated
 * phrase. Two, not three: a real hook ("Just shipped", "Excited to") tends
 * to be reused with the sentence finished a different way each time, so a
 * three-word match would miss it. */
const OPENING_WORDS = 2;
/** Closings are compared over one more word - a sign-off ("let me know
 * what you think") reads as a phrase over a longer span than an opening
 * hook does. */
const CLOSING_WORDS = 3;
/** Floor on how many separate items must share a phrase, emoji or hashtag
 * before it counts as recurring, regardless of corpus size. */
const MIN_PHRASE_REPEATS = 2;
/** Above the floor, a phrase has to cover this fraction of the corpus - a
 * bigger corpus should need more than two coincidental matches to call
 * something a habit. */
const PHRASE_COVERAGE_RATIO = 0.1;
const MAX_PHRASES = 3;

/** Floor on how many separate items a word must appear in before it counts
 * as reused, regardless of corpus size. */
const MIN_WORD_ITEM_COVERAGE = 3;
const WORD_COVERAGE_RATIO = 0.15;
const MAX_COMMON_WORDS = 5;
const MIN_WORD_LENGTH = 4;

// A short stopword list, English and Italian (register.ts's own FORMAL_WORDS
// and FIRST_PERSON carry the same split, for the same reason: Lorenzo's own
// writing is half Italian). Purely to keep "words they reuse" from reporting
// grammar rather than vocabulary - it does not need to be exhaustive, only
// to keep the five most-reused function words out of the result.
const STOPWORDS: Record<string, true> = {
  the: true,
  and: true,
  for: true,
  with: true,
  that: true,
  this: true,
  have: true,
  from: true,
  they: true,
  their: true,
  them: true,
  your: true,
  you: true,
  are: true,
  was: true,
  were: true,
  been: true,
  being: true,
  into: true,
  about: true,
  over: true,
  after: true,
  not: true,
  just: true,
  also: true,
  more: true,
  most: true,
  one: true,
  two: true,
  what: true,
  when: true,
  where: true,
  which: true,
  while: true,
  than: true,
  then: true,
  there: true,
  here: true,
  out: true,
  who: true,
  how: true,
  per: true,
  che: true,
  non: true,
  come: true,
  anche: true,
  più: true,
  molto: true,
  questo: true,
  questa: true,
  questi: true,
  queste: true,
  sono: true,
  abbiamo: true,
  loro: true,
  della: true,
  dello: true,
  delle: true,
  degli: true,
  nel: true,
  nella: true,
  nelle: true,
  negli: true,
  con: true,
  tra: true,
  fra: true,
  una: true,
  uno: true,
};

const normalizeWord = (word: string): string =>
  word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Finds phrases (the first `windowWords` words of an item, or the last, for
 * a closing) that repeat across enough separate items to count as a habit
 * rather than a coincidence. Keeps the first real (non-normalized)
 * rendering of each phrase to show back to a human. */
function topRepeatedPhrases(
  wordLists: string[][],
  windowWords: number,
  fromEnd: boolean,
): string[] {
  const counts = new Map<string, { count: number; display: string }>();
  for (const words of wordLists) {
    if (words.length < windowWords) continue;
    const slice = fromEnd ? words.slice(-windowWords) : words.slice(0, windowWords);
    const key = slice.map(normalizeWord).join(' ').trim();
    if (!key) continue;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { count: 1, display: slice.join(' ') });
  }
  const threshold = Math.max(
    MIN_PHRASE_REPEATS,
    Math.ceil(wordLists.length * PHRASE_COVERAGE_RATIO),
  );
  return [...counts.values()]
    .filter((v) => v.count >= threshold)
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .slice(0, MAX_PHRASES)
    .map((v) => v.display);
}

/** Words that show up in enough separate items to count as reused, rather
 * than merely repeated within one long post. Coverage is counted per item
 * (a word used ten times in one post counts once), because reuse is a
 * property of the corpus, not of any single piece of writing. */
function topCommonWords(wordLists: string[][]): string[] {
  const itemCoverage = new Map<string, number>();
  for (const words of wordLists) {
    const seenInItem = new Set<string>();
    for (const raw of words) {
      const w = normalizeWord(raw);
      if (w.length < MIN_WORD_LENGTH || STOPWORDS[w] || /^\d+$/u.test(w)) continue;
      seenInItem.add(w);
    }
    for (const w of seenInItem) itemCoverage.set(w, (itemCoverage.get(w) ?? 0) + 1);
  }
  const threshold = Math.max(
    MIN_WORD_ITEM_COVERAGE,
    Math.ceil(wordLists.length * WORD_COVERAGE_RATIO),
  );
  return [...itemCoverage.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_COMMON_WORDS)
    .map(([w]) => w);
}

// ---------------------------------------------------------------------------
// Small numeric helpers shared by the axes below. Kept local: none of this
// is specific to voice, but a shared math-utils module would be one more
// place to look for what is otherwise a handful of small functions.
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Interquartile range - the spread measure #570 asks for ("median and
 * spread, not just mean"). Robust to one unusually long or short item in a
 * small corpus the way a standard deviation is not. */
function interquartileRange(nums: number[]): number {
  if (nums.length < 4) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const q1 = median(sorted.slice(0, half));
  const q3 = median(sorted.slice(sorted.length - half));
  return round2(q3 - q1);
}

function perHundredWords(count: number, wordCount: number): number {
  return wordCount > 0 ? round2((count / wordCount) * 100) : 0;
}

// Sentence ends, with the common abbreviations that would otherwise split a
// sentence in half left alone by requiring whitespace or a line break after
// the mark - the same split register.ts uses, kept in step on purpose.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])(?:\s+|\n)/u)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/u).filter(Boolean).length > 0);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rhythm: sentence and paragraph length, and whether a piece opens short.
// ---------------------------------------------------------------------------

export type RhythmProfile = {
  /** Median words in a whole piece of writing, not in a sentence (LOR-231).
   * This is the axis a suggestion misses by the widest margin and the one
   * nothing reported until now: measured 2026-09-11 on a real corpus, the
   * operator's own comments run a median of 7 words while the suggestions
   * written "in his voice" ran 123, and every number below was already
   * correct while that one was simply absent from the description. */
  medianItemWords: number;
  /** Interquartile range of whole-piece length. A corpus whose pieces run
   * 5 to 9 words and one whose pieces run 2 to 200 have the same median
   * and call for different drafts. */
  itemWordsSpread: number;
  /** Median words per sentence, pooled across every sentence in the corpus
   * - not the mean of each item's own mean, which one long or short outlier
   * post can skew more than it should. */
  medianSentenceWords: number;
  /** Interquartile range of sentence length: how much it varies, not just
   * where the middle sits. */
  sentenceWordsSpread: number;
  medianParagraphWords: number;
  /** Fraction of sentences at or under FRAGMENT_MAX_WORDS - "shipped
   * yesterday" reads as a fragment, not a sentence missing its subject. */
  fragmentRatio: number;
  /** Fraction of items whose first sentence is at or under
   * SHORT_OPENING_MAX_WORDS words. */
  shortOpeningRatio: number;
};

const FRAGMENT_MAX_WORDS = 4;
const SHORT_OPENING_MAX_WORDS = 6;

export const EMPTY_RHYTHM: RhythmProfile = {
  medianItemWords: 0,
  itemWordsSpread: 0,
  medianSentenceWords: 0,
  sentenceWordsSpread: 0,
  medianParagraphWords: 0,
  fragmentRatio: 0,
  shortOpeningRatio: 0,
};

function measureRhythm(texts: string[]): RhythmProfile {
  const sentenceWordCounts: number[] = [];
  const paragraphWordCounts: number[] = [];
  const itemWordCounts: number[] = [];
  let shortOpenings = 0;
  let fragments = 0;

  for (const text of texts) {
    itemWordCounts.push(text.split(/\s+/u).filter(Boolean).length);
    const sentences = splitSentences(text);
    for (const s of sentences) {
      const words = s.split(/\s+/u).filter(Boolean).length;
      sentenceWordCounts.push(words);
      if (words <= FRAGMENT_MAX_WORDS) fragments += 1;
    }
    if (sentences.length > 0) {
      const firstWords = sentences[0]!.split(/\s+/u).filter(Boolean).length;
      if (firstWords <= SHORT_OPENING_MAX_WORDS) shortOpenings += 1;
    }
    for (const p of splitParagraphs(text)) {
      paragraphWordCounts.push(p.split(/\s+/u).filter(Boolean).length);
    }
  }

  return {
    medianItemWords: Math.round(median(itemWordCounts)),
    itemWordsSpread: interquartileRange(itemWordCounts),
    medianSentenceWords: Math.round(median(sentenceWordCounts)),
    sentenceWordsSpread: interquartileRange(sentenceWordCounts),
    medianParagraphWords: Math.round(median(paragraphWordCounts)),
    fragmentRatio:
      sentenceWordCounts.length > 0 ? round2(fragments / sentenceWordCounts.length) : 0,
    shortOpeningRatio: texts.length > 0 ? round2(shortOpenings / texts.length) : 0,
  };
}

// ---------------------------------------------------------------------------
// Punctuation and typography.
// ---------------------------------------------------------------------------

export type PunctuationProfile = {
  commasPer100Words: number;
  colonsPer100Words: number;
  parenthesesPer100Words: number;
  /** An em dash, en dash, or a hyphen surrounded by spaces used as a pause
   * - not a hyphen inside a compound word ("self-host", "game-changer"),
   * which is spelling rather than punctuation. */
  dashesPer100Words: number;
  questionMarksPer100Words: number;
  exclamationMarksPer100Words: number;
  ellipsesPer100Words: number;
  /** Whether a clear majority of items start with an uppercase letter. */
  capitalizesOpenings: boolean;
  /** Whether a clear majority of the colons on file are followed by a
   * lowercase letter rather than a capital ("the point: it worked" vs "The
   * point: It worked"). Only counted on colons that are actually followed
   * by a letter. */
  lowercasesAfterColon: boolean;
};

const DASH_PATTERN = /\u2014|\u2013|\s-\s/gu;
const ELLIPSIS_PATTERN = /\.\.\.|\u2026/gu;
const COLON_FOLLOWED_BY_LETTER = /:\s*(\p{L})/gu;

export const EMPTY_PUNCTUATION: PunctuationProfile = {
  commasPer100Words: 0,
  colonsPer100Words: 0,
  parenthesesPer100Words: 0,
  dashesPer100Words: 0,
  questionMarksPer100Words: 0,
  exclamationMarksPer100Words: 0,
  ellipsesPer100Words: 0,
  capitalizesOpenings: false,
  lowercasesAfterColon: false,
};

function measurePunctuation(texts: string[], wordCount: number): PunctuationProfile {
  let commas = 0;
  let colons = 0;
  let parens = 0;
  let dashes = 0;
  let questions = 0;
  let exclamations = 0;
  let ellipses = 0;
  let capitalized = 0;
  let capitalizable = 0;
  let lowercaseAfterColon = 0;
  let colonSamples = 0;

  for (const text of texts) {
    commas += (text.match(/,/gu) ?? []).length;
    colons += (text.match(/:/gu) ?? []).length;
    parens += (text.match(/[()]/gu) ?? []).length;
    dashes += (text.match(DASH_PATTERN) ?? []).length;
    questions += (text.match(/\?/gu) ?? []).length;
    exclamations += (text.match(/!/gu) ?? []).length;
    ellipses += (text.match(ELLIPSIS_PATTERN) ?? []).length;

    const firstLetter = text.match(/\p{L}/u)?.[0];
    if (firstLetter) {
      capitalizable += 1;
      if (firstLetter === firstLetter.toUpperCase() && firstLetter !== firstLetter.toLowerCase()) {
        capitalized += 1;
      }
    }

    for (const match of text.matchAll(COLON_FOLLOWED_BY_LETTER)) {
      colonSamples += 1;
      const letter = match[1]!;
      if (letter === letter.toLowerCase() && letter !== letter.toUpperCase()) {
        lowercaseAfterColon += 1;
      }
    }
  }

  return {
    commasPer100Words: perHundredWords(commas, wordCount),
    colonsPer100Words: perHundredWords(colons, wordCount),
    parenthesesPer100Words: perHundredWords(parens, wordCount),
    dashesPer100Words: perHundredWords(dashes, wordCount),
    questionMarksPer100Words: perHundredWords(questions, wordCount),
    exclamationMarksPer100Words: perHundredWords(exclamations, wordCount),
    ellipsesPer100Words: perHundredWords(ellipses, wordCount),
    capitalizesOpenings: capitalizable > 0 && capitalized / capitalizable >= TRAIT_DOMINANCE_RATIO,
    lowercasesAfterColon:
      colonSamples > 0 && lowercaseAfterColon / colonSamples >= TRAIT_DOMINANCE_RATIO,
  };
}

// ---------------------------------------------------------------------------
// Shape: paragraph layout, emoji, hashtags, how a piece ends.
// ---------------------------------------------------------------------------

export type PostEnding = 'question' | 'claim' | 'none';

export type ShapeProfile = {
  lineBreaksPerParagraph: number;
  /** Mirrors the corpus-level 'list-layout' register trait rather than
   * re-deriving it - one detector for "is this laid out as a list". */
  usesLists: boolean;
  /** Distinct emoji reused across at least two separate items, most-used
   * first. */
  emoji: string[];
  /** Distinct hashtags reused the same way. */
  hashtags: string[];
  /** How the corpus tends to end - question, claim (a full stop or
   * exclamation) or trailing off with neither - only when a clear majority
   * agree; null otherwise. */
  ending: PostEnding | null;
};

const MAX_EMOJI = 5;
const MAX_HASHTAGS = 5;
// Same pictographic ranges register.ts's EMOJI pattern uses, global so every
// occurrence in a piece is found rather than just the first.
const EMOJI_GLOBAL =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]\u{FE0F}?/gu;
const HASHTAG_GLOBAL = /#[\p{L}\p{N}_]+/gu;

export const EMPTY_SHAPE: ShapeProfile = {
  lineBreaksPerParagraph: 0,
  usesLists: false,
  emoji: [],
  hashtags: [],
  ending: null,
};

/** Distinct tokens (emoji, hashtags) that show up in at least
 * MIN_PHRASE_REPEATS separate items, ranked by how many items carry them -
 * the same per-item-coverage discipline `topCommonWords` uses for
 * vocabulary. */
function topRepeatedTokens(texts: string[], pattern: RegExp, max: number): string[] {
  const coverage = new Map<string, { count: number; display: string }>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      const tok = match[0];
      const key = tok.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = coverage.get(key);
      if (existing) existing.count += 1;
      else coverage.set(key, { count: 1, display: tok });
    }
  }
  return [...coverage.values()]
    .filter((v) => v.count >= MIN_PHRASE_REPEATS)
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .slice(0, max)
    .map((v) => v.display);
}

function measureShape(texts: string[], usesLists: boolean): ShapeProfile {
  const paragraphLineBreaks: number[] = [];
  const endings: PostEnding[] = [];

  for (const text of texts) {
    for (const p of splitParagraphs(text)) {
      paragraphLineBreaks.push((p.match(/\n/gu) ?? []).length);
    }
    const lastChar = text.trim().slice(-1);
    if (lastChar === '?') endings.push('question');
    else if (lastChar === '.' || lastChar === '!') endings.push('claim');
    else endings.push('none');
  }

  const endingCounts = new Map<PostEnding, number>();
  for (const e of endings) endingCounts.set(e, (endingCounts.get(e) ?? 0) + 1);
  let dominantEnding: PostEnding | null = null;
  for (const [e, count] of endingCounts) {
    if (count >= endings.length * TRAIT_DOMINANCE_RATIO) dominantEnding = e;
  }

  return {
    lineBreaksPerParagraph:
      paragraphLineBreaks.length > 0
        ? round2(paragraphLineBreaks.reduce((a, b) => a + b, 0) / paragraphLineBreaks.length)
        : 0,
    usesLists,
    emoji: topRepeatedTokens(texts, EMOJI_GLOBAL, MAX_EMOJI),
    hashtags: topRepeatedTokens(texts, HASHTAG_GLOBAL, MAX_HASHTAGS),
    ending: dominantEnding,
  };
}

// ---------------------------------------------------------------------------
// Voice markers: first/second person, hedges, certainty, imperatives.
// ---------------------------------------------------------------------------

export type VoiceMarkerProfile = {
  firstPersonPer100Words: number;
  secondPersonPer100Words: number;
  hedgesPer100Words: number;
  certaintyPer100Words: number;
  /** Fraction of sentences that open on a known imperative verb ("Try",
   * "Ship", "Prova", "Non"...). Approximate by design - the same spirit as
   * register.ts's CODE_OR_JARGON heuristic, a short named list rather than
   * real parsing, good enough to say "sometimes" versus "never". */
  imperativeRatio: number;
};

const FIRST_PERSON_GLOBAL =
  /\b(?:i|i'm|i've|my|me|we|we're|our|io|mi|miei|mia|noi|nostro|nostra|abbiamo|ho)\b/giu;
const SECOND_PERSON_GLOBAL =
  /\b(?:you|you're|your|yours|tu|tuo|tua|tuoi|tue|voi|vostro|vostra)\b/giu;
const HEDGE_GLOBAL =
  /\b(?:i think|i guess|probably|maybe|kind of|sort of|credo|forse|penso|magari)\b/giu;
const CERTAINTY_GLOBAL =
  /\b(?:clearly|obviously|definitely|certainly|without a doubt|certamente|chiaramente|sicuramente|ovviamente)\b/giu;

const IMPERATIVE_OPENERS: Record<string, true> = {
  try: true,
  build: true,
  ship: true,
  stop: true,
  start: true,
  look: true,
  think: true,
  consider: true,
  "don't": true,
  dont: true,
  do: true,
  prova: true,
  costruisci: true,
  inizia: true,
  guarda: true,
  pensa: true,
  smetti: true,
  fai: true,
};

export const EMPTY_VOICE_MARKERS: VoiceMarkerProfile = {
  firstPersonPer100Words: 0,
  secondPersonPer100Words: 0,
  hedgesPer100Words: 0,
  certaintyPer100Words: 0,
  imperativeRatio: 0,
};

function measureVoiceMarkers(texts: string[], wordCount: number): VoiceMarkerProfile {
  let firstPerson = 0;
  let secondPerson = 0;
  let hedges = 0;
  let certainty = 0;
  let imperativeSentences = 0;
  let totalSentences = 0;

  for (const text of texts) {
    firstPerson += (text.match(FIRST_PERSON_GLOBAL) ?? []).length;
    secondPerson += (text.match(SECOND_PERSON_GLOBAL) ?? []).length;
    hedges += (text.match(HEDGE_GLOBAL) ?? []).length;
    certainty += (text.match(CERTAINTY_GLOBAL) ?? []).length;

    for (const s of splitSentences(text)) {
      totalSentences += 1;
      const firstWord = normalizeWord(s.split(/\s+/u)[0] ?? '');
      if (IMPERATIVE_OPENERS[firstWord]) imperativeSentences += 1;
    }
  }

  return {
    firstPersonPer100Words: perHundredWords(firstPerson, wordCount),
    secondPersonPer100Words: perHundredWords(secondPerson, wordCount),
    hedgesPer100Words: perHundredWords(hedges, wordCount),
    certaintyPer100Words: perHundredWords(certainty, wordCount),
    imperativeRatio: totalSentences > 0 ? round2(imperativeSentences / totalSentences) : 0,
  };
}

// ---------------------------------------------------------------------------
// Lexicon: which candidate "default-sounding" words never show up.
// ---------------------------------------------------------------------------

export type LexiconProfile = {
  /** Candidate puffery/filler words that never appear anywhere in the
   * corpus. Only populated once the corpus is large enough that an absence
   * means something (AVOIDED_WORDS_MIN_WORDS) - a two-post corpus that
   * never says "leverage" has not avoided it, it has not had the chance to
   * use it. */
  avoidedWords: string[];
};

/** Below this many words, an absence proves nothing. Exported so a single-
 * text comparison (voice-metrics.ts, LOR-44) can gate the lexicon axis on
 * the exact same floor rather than guessing a second one. */
export const AVOIDED_WORDS_MIN_WORDS = 200;

/** Candidate words a default-sounding draft leaks - mirrors house style's
 * puffery bans (`shared/src/style-check.ts`'s PUFFERY_WORDS and
 * WRAPUP_CLOSERS) plus the LinkedIn-specific ones #571 names. Kept local
 * rather than imported: this is read-only evidence about what the
 * operator's own writing never touches, not a second enforcement surface -
 * `checkStyle` stays the one thing that blocks a draft, so a local list
 * here cannot drift into changing what it blocks. */
const AVOIDABLE_WORD_CANDIDATES = [
  'leverage',
  'seamless',
  'robust',
  'comprehensive',
  'delve',
  'unlock',
  'elevate',
  'game-changer',
  'humbled',
  'thrilled to share',
  'this resonates',
  'hope this helps',
  'at the end of the day',
  'the bottom line is',
];

export const EMPTY_LEXICON: LexiconProfile = { avoidedWords: [] };

function measureLexicon(joinedText: string, wordCount: number): LexiconProfile {
  if (wordCount < AVOIDED_WORDS_MIN_WORDS) return { avoidedWords: [] };
  const lower = joinedText.toLowerCase();
  return { avoidedWords: AVOIDABLE_WORD_CANDIDATES.filter((w) => !lower.includes(w)) };
}

// ---------------------------------------------------------------------------
// Language: the English/Italian split, overall and per corpus surface.
// ---------------------------------------------------------------------------

export type LanguageMix = {
  primary: 'en' | 'it' | 'mixed' | null;
  englishRatio: number;
  italianRatio: number;
};

export type LanguageProfile = LanguageMix & {
  /** The same split computed separately for each corpus surface that has
   * enough items of its own to classify - a suggestion has to match the
   * post's language, and an operator whose voice samples are all English
   * but whose sent messages are half Italian is not describable by one
   * average. Kinds with too few items of their own are simply absent. */
  byKind: Partial<Record<VoiceCorpusItemKind, LanguageMix>>;
};

// A short, real stopword list per language rather than a library
// dependency - the same tradeoff register.ts's FORMAL_WORDS makes. Enough
// to tell "the update shipped today" from "l'aggiornamento è uscito oggi"
// without claiming to be a general-purpose language detector.
const EN_STOPWORDS_GLOBAL =
  /\b(?:the|and|of|to|is|that|with|for|this|was|are|it's|i'm|we|you)\b/giu;
const IT_STOPWORDS_GLOBAL =
  /\b(?:il|la|di|che|per|con|un|una|è|non|questo|questa|sono|abbiamo|nel|della)\b/giu;

/** Below this many stopword hits, a text has not said enough to classify -
 * one stray "the" in an otherwise Italian post is not evidence. */
const LANGUAGE_MARKER_MIN = 2;
/** Above this share, one language is called primary outright rather than
 * "mixed" - the split has to be lopsided, not just plurality. */
const PRIMARY_LANGUAGE_RATIO = 0.7;

export const EMPTY_LANGUAGE: LanguageProfile = {
  primary: null,
  englishRatio: 0,
  italianRatio: 0,
  byKind: {},
};

export function classifyLanguage(text: string): 'en' | 'it' | 'unknown' {
  const en = (text.match(EN_STOPWORDS_GLOBAL) ?? []).length;
  const it = (text.match(IT_STOPWORDS_GLOBAL) ?? []).length;
  if (en >= LANGUAGE_MARKER_MIN && en > it) return 'en';
  if (it >= LANGUAGE_MARKER_MIN && it > en) return 'it';
  return 'unknown';
}

function summarizeLanguage(texts: string[]): LanguageMix {
  if (texts.length === 0) return { primary: null, englishRatio: 0, italianRatio: 0 };
  const classified = texts.map(classifyLanguage);
  const en = classified.filter((c) => c === 'en').length;
  const it = classified.filter((c) => c === 'it').length;
  const englishRatio = round2(en / texts.length);
  const italianRatio = round2(it / texts.length);

  let primary: 'en' | 'it' | 'mixed' | null;
  if (en === 0 && it === 0) primary = null;
  else if (englishRatio >= PRIMARY_LANGUAGE_RATIO) primary = 'en';
  else if (italianRatio >= PRIMARY_LANGUAGE_RATIO) primary = 'it';
  else if (en > 0 && it > 0) primary = 'mixed';
  else primary = en > it ? 'en' : 'it';

  return { primary, englishRatio, italianRatio };
}

function measureLanguage(items: VoiceCorpusItem[]): LanguageProfile {
  const overall = summarizeLanguage(items.map((i) => i.text));
  const byKind: LanguageProfile['byKind'] = {};
  for (const kind of VOICE_CORPUS_ITEM_KINDS) {
    const kindTexts = items.filter((i) => i.kind === kind).map((i) => i.text);
    if (kindTexts.length < MIN_ITEMS_TO_DERIVE) continue;
    byKind[kind] = summarizeLanguage(kindTexts);
  }
  return { ...overall, byKind };
}

// ---------------------------------------------------------------------------
// The measurement itself.
// ---------------------------------------------------------------------------

export type VoiceMeasurement = {
  /** Non-empty corpus items considered, regardless of whether any were
   * individually long enough to read a register off. */
  itemCount: number;
  /** Total words across every item. */
  wordCount: number;
  /** False when the corpus is too small to say anything honest about -
   * every field below is empty/zero in that case, not a guess. */
  measurable: boolean;
  traits: RegisterTrait[];
  /** Mean of each measurable item's own words-per-sentence. 0 when
   * unmeasurable. */
  wordsPerSentence: number;
  openings: string[];
  closings: string[];
  commonWords: string[];
  rhythm: RhythmProfile;
  punctuation: PunctuationProfile;
  shape: ShapeProfile;
  voiceMarkers: VoiceMarkerProfile;
  lexicon: LexiconProfile;
  language: LanguageProfile;
};

/**
 * Measures a corpus of the operator's own writing. Pure, synchronous, no
 * model, no I/O - the DB-touching part (gathering the corpus) lives in
 * `operator-voice-profile.ts`, upstream of this function, the same split
 * `suggest-prompt.ts` keeps from `context.ts`.
 */
export function measureVoiceCorpus(corpus: VoiceCorpusItem[]): VoiceMeasurement {
  const items = corpus.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
  const texts = items.map((i) => i.text);
  const wordLists = texts.map((t) => t.split(/\s+/u).filter(Boolean));
  const wordCount = wordLists.reduce((sum, w) => sum + w.length, 0);
  const itemCount = texts.length;

  if (itemCount < MIN_ITEMS_TO_DERIVE) {
    return {
      itemCount,
      wordCount,
      measurable: false,
      traits: [],
      wordsPerSentence: 0,
      openings: [],
      closings: [],
      commonWords: [],
      rhythm: EMPTY_RHYTHM,
      punctuation: EMPTY_PUNCTUATION,
      shape: EMPTY_SHAPE,
      voiceMarkers: EMPTY_VOICE_MARKERS,
      lexicon: EMPTY_LEXICON,
      language: EMPTY_LANGUAGE,
    };
  }

  // Register traits and sentence length need each item to individually
  // clear register.ts's own floor (MIN_WORDS_TO_DESCRIBE) - a corpus of
  // long posts and one-line drafts should not have the one-liners drag an
  // average down when they carry no measurable register of their own.
  const registers = texts.map((t) => readPostRegister(t)).filter((r) => r !== null);
  let traits: RegisterTrait[] = [];
  let wordsPerSentence = 0;
  if (registers.length >= MIN_ITEMS_TO_DERIVE) {
    const traitCounts = new Map<RegisterTrait, number>();
    for (const r of registers) {
      for (const t of r.traits) traitCounts.set(t, (traitCounts.get(t) ?? 0) + 1);
    }
    const dominanceThreshold = registers.length * TRAIT_DOMINANCE_RATIO;
    traits = [...traitCounts.entries()]
      .filter(([, count]) => count >= dominanceThreshold)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
    wordsPerSentence = Math.round(
      registers.reduce((sum, r) => sum + r.wordsPerSentence, 0) / registers.length,
    );
  }

  return {
    itemCount,
    wordCount,
    measurable: true,
    traits,
    wordsPerSentence,
    openings: topRepeatedPhrases(wordLists, OPENING_WORDS, false),
    closings: topRepeatedPhrases(wordLists, CLOSING_WORDS, true),
    commonWords: topCommonWords(wordLists),
    rhythm: measureRhythm(texts),
    punctuation: measurePunctuation(texts, wordCount),
    shape: measureShape(texts, traits.includes('list-layout')),
    voiceMarkers: measureVoiceMarkers(texts, wordCount),
    lexicon: measureLexicon(texts.join(' '), wordCount),
    language: measureLanguage(items),
  };
}

// ---------------------------------------------------------------------------
// A single piece of text, not a corpus (LOR-44).
// ---------------------------------------------------------------------------

export type OneTextMeasurement = {
  wordCount: number;
  /** Null exactly when register.ts's own floor (MIN_WORDS_TO_DESCRIBE) says
   * this text is too short to have measurable habits - a caller comparing
   * two texts should read that as "this axis is not measurable here", never
   * as a zero or a match. */
  register: PostRegister | null;
  rhythm: RhythmProfile;
  punctuation: PunctuationProfile;
  shape: ShapeProfile;
  voiceMarkers: VoiceMarkerProfile;
  lexicon: LexiconProfile;
  language: 'en' | 'it' | 'unknown';
};

/**
 * The same six axes `measureVoiceCorpus` derives from a corpus, read off a
 * single piece of text instead - voice-metrics.ts's (LOR-44) entry point for
 * comparing one candidate against one real reply rather than describing a
 * habit across many. Deliberately not a second implementation: every axis
 * below calls the exact function `measureVoiceCorpus` calls, just with a
 * one-item list, so this can never drift from what a corpus measurement
 * means. `usesLists` (shape's own corpus-level trait) falls back the same
 * way `measureVoiceCorpus` does - off register's own traits, gated by the
 * same MIN_WORDS_TO_DESCRIBE floor as everything else here.
 */
export function measureOneText(text: string): OneTextMeasurement {
  const t = text.trim();
  const texts = t ? [t] : [];
  const wordCount = t ? t.split(/\s+/u).filter(Boolean).length : 0;
  const register = readPostRegister(t);
  return {
    wordCount,
    register,
    rhythm: measureRhythm(texts),
    punctuation: measurePunctuation(texts, wordCount),
    shape: measureShape(texts, register?.traits.includes('list-layout') ?? false),
    voiceMarkers: measureVoiceMarkers(texts, wordCount),
    lexicon: measureLexicon(t, wordCount),
    language: classifyLanguage(t),
  };
}

const TRAIT_PROSE: Record<RegisterTrait, string> = {
  'long-sentences': 'long, built-up sentences',
  'short-sentences': 'short sentences, close to speech',
  'first-person': 'first person, speaking as themselves',
  impersonal: 'impersonal, no first person',
  contractions: 'contractions, informal',
  'formal-wording': 'formal connectives',
  exclamations: 'exclamation marks',
  questions: 'asks questions of the reader',
  emoji: 'emoji',
  hashtags: 'hashtags',
  'list-layout': 'laid out as a list',
  numbers: 'argues with numbers',
  'code-or-jargon': 'technical terms and identifiers',
};

const ENDING_PROSE: Record<PostEnding, string> = {
  question: 'a question',
  claim: 'a claim',
  none: 'no clear ending, trailing off',
};

const LANGUAGE_PROSE: Record<Exclude<LanguageMix['primary'], null>, string> = {
  en: 'English',
  it: 'Italian',
  mixed: 'both English and Italian',
};

/**
 * The measurement as prose, for the prompt and for Settings. Separate from
 * the measurement itself so the numbers can be asserted without pinning the
 * English (register.ts's own reasoning for the same split). Returns null
 * when the corpus said nothing worth reporting - too small, or measurable
 * but with no dominant trait, phrase or reused word - which the prompt
 * renders as no voice-profile section at all rather than an empty one.
 *
 * `noun` names what was counted in the leading sentence - "pieces of their
 * own writing" for the pooled corpus, "of their own posts"/"comments" for
 * a genre-scoped one (LOR-223's `describeVoiceProfileForGenre`) - so the
 * same renderer works for both without the caller reaching into the
 * string afterward.
 */
export function describeVoiceProfile(
  m: VoiceMeasurement,
  noun = 'pieces of their own writing',
): string | null {
  if (!m.measurable) return null;

  const sentences: string[] = [];
  // Length of a whole piece comes first, because it is the axis a draft
  // misses by the widest margin and the one a reader notices before any
  // other (LOR-231). It is also the one axis here that survives a corpus
  // of very short items: register traits and words-per-sentence both need
  // each item to clear register.ts's 12-word floor, which a corpus of
  // one-line comments never does, so before this the description of such a
  // corpus said everything about it except how long it is.
  if (m.rhythm.medianItemWords > 0) {
    const spread = m.rhythm.itemWordsSpread > 0 ? `, give or take ${m.rhythm.itemWordsSpread}` : '';
    sentences.push(
      `A typical one runs about ${m.rhythm.medianItemWords} words${spread}, and a draft that misses that length is wrong however well it is written.`,
    );
  }
  if (m.traits.length > 0) {
    const sentenceLength =
      m.wordsPerSentence > 0 ? `, about ${m.wordsPerSentence} words per sentence` : '';
    sentences.push(
      `Usually writes with ${m.traits.map((t) => TRAIT_PROSE[t]).join(', ')}${sentenceLength}.`,
    );
  } else if (m.wordsPerSentence > 0) {
    sentences.push(`About ${m.wordsPerSentence} words per sentence on average.`);
  }
  if (m.openings.length > 0) {
    sentences.push(`Often opens with "${m.openings.join('", "')}".`);
  }
  if (m.closings.length > 0) {
    sentences.push(`Often closes with "${m.closings.join('", "')}".`);
  }
  if (m.commonWords.length > 0) {
    sentences.push(`Reuses these words often: ${m.commonWords.join(', ')}.`);
  }
  if (m.shape.ending) {
    sentences.push(`Tends to end on ${ENDING_PROSE[m.shape.ending]}.`);
  }
  if (m.shape.emoji.length > 0) {
    sentences.push(`Uses these emoji: ${m.shape.emoji.join(' ')}.`);
  }
  if (m.shape.hashtags.length > 0) {
    sentences.push(`Uses these hashtags: ${m.shape.hashtags.join(', ')}.`);
  }
  if (m.lexicon.avoidedWords.length > 0) {
    sentences.push(`Never uses: ${m.lexicon.avoidedWords.join(', ')}.`);
  }
  if (m.language.primary) {
    sentences.push(`Writes primarily in ${LANGUAGE_PROSE[m.language.primary]}.`);
  }

  if (sentences.length === 0) return null;
  return `Based on ${m.itemCount} ${noun} (${m.wordCount} words). ${sentences.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Per-genre measurement (LOR-223): a post and a comment are different
// genres of writing, not the same voice at a different length, so each gets
// its own measurement rather than one pooled average diluting both. The
// pooled `measureVoiceCorpus` above is unchanged and still the right call
// for "how does this person write, overall" - this is the addition, not a
// replacement.
// ---------------------------------------------------------------------------

const GENRE_NOUN: Record<VoiceCorpusItemGenre, string> = {
  post: 'of their own posts',
  comment: 'of their own comments',
  reply: 'of their own replies',
};

/**
 * `measureVoiceCorpus`, once per genre, over only the corpus items that
 * carry one (a message, sent draft or template has no genre and is simply
 * absent from every bucket - it already counts toward the pooled
 * measurement). Every genre in `VOICE_CORPUS_ITEM_GENRES` is always a key
 * in the result, `measurable: false` when that genre's own item count has
 * not cleared `MIN_ITEMS_TO_DERIVE` - the same "say nothing rather than
 * guess" discipline the pooled measurement already applies, now per genre
 * rather than only across the whole corpus.
 *
 * A genre whose items are individually short (LinkedIn comments run a
 * median of a handful of words - well under `register.ts`'s own floor for
 * a single item to carry a register, and often under the two stopword hits
 * `measureLanguage` needs to classify one) is not the same thing as a
 * genre with too few items: `MIN_ITEMS_TO_DERIVE` gates on `itemCount`,
 * every other floor below it (register's word count, the language
 * classifier's stopword count, lexicon's 200-word floor) is already
 * per-item or per-corpus-word-count rather than per-genre, so a comment
 * corpus large enough in item count still reports rhythm and shape
 * honestly even when few individual comments clear register.ts's floor -
 * it just reports an empty `traits`/`wordsPerSentence` rather than one
 * derived from too little.
 */
export function measureVoiceCorpusByGenre(
  corpus: VoiceCorpusItem[],
): Record<VoiceCorpusItemGenre, VoiceMeasurement> {
  const result = {} as Record<VoiceCorpusItemGenre, VoiceMeasurement>;
  for (const genre of VOICE_CORPUS_ITEM_GENRES) {
    result[genre] = measureVoiceCorpus(corpus.filter((item) => item.genre === genre));
  }
  return result;
}

/** `describeVoiceProfile`, worded for one genre ("Based on 12 of their own
 * comments" rather than "12 pieces of their own writing"). */
export function describeVoiceProfileForGenre(
  genre: VoiceCorpusItemGenre,
  m: VoiceMeasurement,
): string | null {
  return describeVoiceProfile(m, GENRE_NOUN[genre]);
}
