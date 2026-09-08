// shared/src/assist/register.ts
//
// The half of the tone mix that comes from the room (#406): a short, honest
// description of how the post being answered is written, so "match the room"
// (#405's default tone) has something concrete to match.
//
// Deliberately not a model call. Every property below is a countable property
// of the text - sentence length, contractions, emoji, list markers, digits -
// and a mechanical subtask with one correct answer does not belong in a model
// (see the reflect note in ~/.config/agents/skills/moving-work-out-of-the-model).
// The suggest path already spends 10 to 14 seconds before its first token
// (#360, #361), which is the complaint this feature must not make worse, and a
// second round trip to measure punctuation would have doubled it.
//
// What this is not: a classifier, or a judgement about quality. It reports
// what is there and stays silent about what it cannot see, the same rule the
// rest of the prompt follows - a guessed register is worse than none, because
// the model would match the guess.

/** One observation about the post's writing, phrased for the prompt. */
export type RegisterTrait =
  | 'long-sentences'
  | 'short-sentences'
  | 'first-person'
  | 'impersonal'
  | 'contractions'
  | 'formal-wording'
  | 'exclamations'
  | 'questions'
  | 'emoji'
  | 'hashtags'
  | 'list-layout'
  | 'numbers'
  | 'code-or-jargon';

export type PostRegister = {
  traits: RegisterTrait[];
  /** Mean words per sentence, rounded. 0 when there is nothing to measure. */
  wordsPerSentence: number;
  /** Total words, so a two-line post and an essay are not described alike. */
  words: number;
};

/**
 * Anything shorter than this has no measurable habits: three words tell you
 * nothing about sentence length or formality, and describing them as "short
 * sentences, impersonal" is inventing a register out of noise.
 */
const MIN_WORDS_TO_DESCRIBE = 12;

const LONG_SENTENCE_WORDS = 22;
const SHORT_SENTENCE_WORDS = 11;

// Emoji, including the pictographic ranges LinkedIn posts actually use. Kept
// as an explicit range set rather than \p{Emoji}, which matches plain digits
// and `#` and would report emoji on every post that mentions a number.
//
// The variation selector U+FE0F is a separate alternative rather than a member
// of the class: inside a class it combines with the neighbouring range and the
// linter is right that the result is not what it reads as.
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]|\u{FE0F}/u;

// A line that starts with a bullet, a dash, an arrow or "1." - the layout that
// makes a post read as a listicle rather than as prose.
const LIST_LINE = /^\s*(?:[-*•·—>→]|\d+[.)])\s+\S/mu;

const CONTRACTION = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/iu;

// Words that only appear when someone is writing up rather than talking. Both
// languages, since Lorenzo's feed is half Italian: the register of an Italian
// post is not readable with an English-only word list.
const FORMAL_WORDS =
  /\b(?:furthermore|moreover|therefore|hence|thus|accordingly|whilst|pursuant|endeavour|utilise|utilize|commence|inoltre|pertanto|tuttavia|altresì|conseguentemente|in\s+merito|si\s+evidenzia)\b/iu;

const FIRST_PERSON =
  /\b(?:i|i'm|i've|my|me|we|we're|our|io|mi|miei|mia|noi|nostro|nostra|abbiamo|ho)\b/iu;

// Shapes that mean the author is writing technically: an identifier with an
// underscore or camelCase, a code fence, a version number, a file extension,
// or a unit that only appears in engineering copy.
const CODE_OR_JARGON =
  /(?:```|`[^`]+`|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\bv?\d+\.\d+(?:\.\d+)?\b|\.\w{2,4}\b\/|\b(?:api|sdk|k8s|sql|json|latency|throughput|p9[59]|ms\b|gb\b|tb\b)\b)/u;

/**
 * Measures how the post is written. Pure, synchronous, no model, no I/O.
 * Returns null when the text is too short to have habits worth reporting,
 * which the prompt renders as no register section at all.
 */
export function readPostRegister(text: string): PostRegister | null {
  const t = text.trim();
  if (!t) return null;

  const words = t.split(/\s+/u).filter(Boolean);
  if (words.length < MIN_WORDS_TO_DESCRIBE) return null;

  // Sentence ends, with the common abbreviations that would otherwise split a
  // sentence in half left alone by requiring whitespace plus a capital or a
  // line break after the mark.
  const sentences = t
    .split(/(?<=[.!?…])(?:\s+|\n)/u)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/u).filter(Boolean).length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  const wordsPerSentence = Math.round(words.length / sentenceCount);

  const traits: RegisterTrait[] = [];

  if (wordsPerSentence >= LONG_SENTENCE_WORDS) traits.push('long-sentences');
  else if (wordsPerSentence <= SHORT_SENTENCE_WORDS) traits.push('short-sentences');

  if (FIRST_PERSON.test(t)) traits.push('first-person');
  else traits.push('impersonal');

  if (CONTRACTION.test(t)) traits.push('contractions');
  if (FORMAL_WORDS.test(t)) traits.push('formal-wording');

  // One exclamation mark is punctuation; several are a register.
  if ((t.match(/!/gu) ?? []).length >= 2) traits.push('exclamations');
  if (t.includes('?')) traits.push('questions');
  if (EMOJI.test(t)) traits.push('emoji');
  if ((t.match(/(?:^|\s)#\w/gu) ?? []).length >= 2) traits.push('hashtags');
  if (LIST_LINE.test(t)) traits.push('list-layout');
  // Counting digits would call "back in 2019" a numbers habit, since a year
  // is four of them. What makes a post argue with numbers is several distinct
  // ones, or two carrying a unit.
  const numberTokens = t.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (
    numberTokens.length >= 3 ||
    (numberTokens.length >= 2 && /(?:%|\bms\b|\bs\b|percent|per\s?cento|\bx\b)/iu.test(t))
  ) {
    traits.push('numbers');
  }
  if (CODE_OR_JARGON.test(t)) traits.push('code-or-jargon');

  return { traits, wordsPerSentence, words: words.length };
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
 * The register as one prompt line. Separate from the measurement so the
 * numbers can be asserted without pinning the English, and so the panel could
 * one day show the same reading without re-deriving it.
 */
export function describePostRegister(register: PostRegister | null): string | null {
  if (!register || register.traits.length === 0) return null;
  const prose = register.traits.map((t) => TRAIT_PROSE[t]).join(', ');
  return `${prose}; about ${register.wordsPerSentence} words per sentence over ${register.words} words`;
}
