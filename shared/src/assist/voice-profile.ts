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

import { readPostRegister, type RegisterTrait } from './register.js';

export type VoiceCorpusItemKind = 'voice_sample' | 'message' | 'draft' | 'template';

/** One piece of the operator's own writing, tagged with where it came from
 * and its id, so the caller can turn a measurement back into evidence
 * (which ids it was derived from) without re-deriving it. */
export type VoiceCorpusItem = {
  id: number;
  kind: VoiceCorpusItemKind;
  text: string;
};

/** Below this many usable pieces of writing, nothing here is trustworthy:
 * two posts sharing an opening word is coincidence, not a habit. */
export const MIN_ITEMS_TO_DERIVE = 3;

/** A register trait counts as habitual, not incidental, only once it shows
 * up in a clear majority of the measurable corpus. */
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
/** Floor on how many separate items must share a phrase before it counts as
 * recurring, regardless of corpus size. */
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
};

/**
 * Measures a corpus of the operator's own writing. Pure, synchronous, no
 * model, no I/O - the DB-touching part (gathering the corpus) lives in
 * `operator-voice-profile.ts`, upstream of this function, the same split
 * `suggest-prompt.ts` keeps from `context.ts`.
 */
export function measureVoiceCorpus(corpus: VoiceCorpusItem[]): VoiceMeasurement {
  const texts = corpus.map((c) => c.text.trim()).filter(Boolean);
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

/**
 * The measurement as prose, for the prompt and for Settings. Separate from
 * the measurement itself so the numbers can be asserted without pinning the
 * English (register.ts's own reasoning for the same split). Returns null
 * when the corpus said nothing worth reporting - too small, or measurable
 * but with no dominant trait, phrase or reused word - which the prompt
 * renders as no voice-profile section at all rather than an empty one.
 */
export function describeVoiceProfile(m: VoiceMeasurement): string | null {
  if (!m.measurable) return null;

  const sentences: string[] = [];
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

  if (sentences.length === 0) return null;
  return `Based on ${m.itemCount} pieces of their own writing (${m.wordCount} words). ${sentences.join(' ')}`;
}
