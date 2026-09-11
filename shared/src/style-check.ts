// shared/src/style-check.ts (#572)
//
// The house style (`shared/src/house-style.ts`) used to be a request: the
// prompt asked for it, and nothing checked what came back. A banned em dash,
// a "not just X but Y", a wrap-up closer - all of it shipped whenever the
// model slipped, and the slip rate is exactly what decides whether a draft
// reads as machine-written.
//
// Every rule here is mechanical: a fixed set of characters, phrases and
// shapes that either are or are not present in a string. That is why it
// belongs in code (~/.config/agents/skills/moving-work-out-of-the-model):
// sharpening the prompt's wording improves the average and never fixes the
// tail, and a rule that only runs when it is convenient is the same rule not
// running. `checkStyle` therefore takes no options and skips nothing - not on
// draft length, not on retune, not on input shape. If a check cannot run on
// some input, that is a bug in the check, not a reason to make it optional.
//
// Two kinds of finding:
//   - "character": a banned punctuation character. `applyMechanicalRepairs`
//     fixes these deterministically, with no model in the loop.
//   - "structural": a construction (a tricolon, a rhetorical-question opener)
//     that cannot be mechanically rewritten. `enforceHouseStyle` sends these
//     back to the model exactly once, naming the span, and re-checks after.
//     A finding still present past that round trip is never silently
//     dropped: it travels with the draft so a human sees it (moving-work
//     -out-of-the-model's "change the evidence, do not weaken the check").
//
// Accent and diacritic characters are never touched by any rule below in a
// way that could catch a letter the rule was not written for: every pattern
// targets a specific punctuation code point, an ASCII phrase, or (for an
// Italian phrase rule added below) an explicit literal spelled exactly as
// the language really writes it - never a broad character class. `shared
// /tests/style-check.test.ts` asserts this directly against Italian and
// French text carrying "è", "più", "café" and friends.
//
// Every phrase-based structural rule below runs a per-language phrase list,
// chosen by `classifyLanguage` (`shared/src/assist/voice-profile.ts`) on the
// text being checked - the corpus is bilingual (English/Italian), so a rule
// that only ever matched English literals was silently not running on half
// of what the product writes. On `unknown` (too little evidence either way)
// both lists run: a false positive on a structural finding costs one model
// round trip, a false negative ships the tell.

import { classifyLanguage } from './assist/voice-profile.js';

export type StyleRuleKind = 'character' | 'structural';

export interface StyleFinding {
  /** Stable id, e.g. "em-dash", "tricolon". Never renamed once shipped: a
   * caller may persist it (drafts.metadata). */
  ruleId: string;
  kind: StyleRuleKind;
  /** One sentence, written for the operator who sees the finding, not for a
   * log. Always English (developer-facing); a finding matched via a
   * non-English phrase list names that language in parentheses so a
   * reviewer is not confused about which list matched. */
  message: string;
  /** The offending text, verbatim, as it appears in the checked string. */
  span: string;
  /** Offsets into the string `checkStyle` was called with. */
  start: number;
  end: number;
  /** Present only on a "character" finding: the exact mechanical
   * replacement `applyMechanicalRepairs` makes for this span. */
  repair?: string;
}

interface Rule {
  id: string;
  kind: StyleRuleKind;
  message: string;
  /** Every match in `text`, earliest first, never overlapping. A match may
   * override `message` (used for a non-English phrase list match) instead
   * of falling back to the rule's own `message`. */
  scan(text: string): Array<{ start: number; end: number; repair?: string; message?: string }>;
}

function regexRule(
  id: string,
  kind: StyleRuleKind,
  message: string,
  pattern: RegExp,
  repair?: (match: string) => string,
): Rule {
  if (!pattern.global) throw new Error(`style-check rule "${id}": pattern must be global`);
  return {
    id,
    kind,
    message,
    scan(text) {
      const out: Array<{ start: number; end: number; repair?: string }> = [];
      for (const m of text.matchAll(pattern)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        out.push({ start, end, repair: repair?.(m[0]) });
      }
      return out;
    },
  };
}

/** Matches a list of literal phrases case-insensitively, anywhere in the
 * text. Each phrase is escaped, so none of them are read as regex syntax. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Character-level rules (house-style.ts: "Characters to never emit").
// Each swaps one banned code point (or a spaced pair of them) for plain
// ASCII; the repair is a pure function of the matched text, so
// `applyMechanicalRepairs` never needs the surrounding string.
// ---------------------------------------------------------------------------

const CHARACTER_RULES: Rule[] = [
  // An em dash, with any whitespace immediately touching it, becomes ", " -
  // proper comma punctuation whether the source wrote it tight ("word—word")
  // or spaced ("word — word"). Nothing else in the string is touched.
  regexRule(
    'em-dash',
    'character',
    'Em dash: house style asks for plain ASCII punctuation instead.',
    /\s*\u2014\s*/gu,
    () => ', ',
  ),
  // A curly double quote becomes a straight one, one code point at a time.
  regexRule(
    'curly-quote',
    'character',
    'Curly double quote: house style asks for a straight quote.',
    /[\u201C\u201D]/gu,
    () => '"',
  ),
  // A curly apostrophe or single quote becomes a straight one.
  regexRule(
    'curly-apostrophe',
    'character',
    'Curly apostrophe: house style asks for a straight apostrophe.',
    /[\u2018\u2019]/gu,
    () => "'",
  ),
  // The single Unicode ellipsis character becomes three ASCII dots.
  regexRule(
    'ellipsis-char',
    'character',
    'Single-character ellipsis: house style asks for three ASCII dots.',
    /\u2026/gu,
    () => '...',
  ),
  // A non-breaking space becomes an ordinary space.
  regexRule(
    'nbsp',
    'character',
    'Non-breaking space: house style asks for a plain space.',
    /\u00A0/gu,
    () => ' ',
  ),
];

/**
 * An en dash is only a house-style violation "between words" (house-style.ts:
 * "en dashes between words"): a numeric range like "2019–2021" is ordinary
 * usage and stays untouched. This needs to look at the nearest non-space
 * neighbour on each side, which a single regex cannot express cleanly, so it
 * is its own scan rather than `regexRule`.
 */
const EN_DASH_BETWEEN_WORDS: Rule = {
  id: 'en-dash-between-words',
  kind: 'character',
  message: 'En dash between words: house style asks for a plain hyphen.',
  scan(text) {
    const out: Array<{ start: number; end: number; repair?: string }> = [];
    const re = /\u2013/gu;
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      let before = idx - 1;
      while (before >= 0 && /\s/u.test(text[before])) before--;
      let after = idx + 1;
      while (after < text.length && /\s/u.test(text[after])) after++;
      const beforeChar = before >= 0 ? text[before] : '';
      const afterChar = after < text.length ? text[after] : '';
      const beforeLetter = /\p{L}/u.test(beforeChar);
      const afterLetter = /\p{L}/u.test(afterChar);
      const beforeDigit = /\d/u.test(beforeChar);
      const afterDigit = /\d/u.test(afterChar);
      // Both sides are digits and neither is a letter: a numeric range, not
      // "between words". Leave it alone.
      if (beforeDigit && afterDigit && !beforeLetter && !afterLetter) continue;
      out.push({ start: idx, end: idx + 1, repair: '-' });
    }
    return out;
  },
};
CHARACTER_RULES.push(EN_DASH_BETWEEN_WORDS);

// ---------------------------------------------------------------------------
// Structural rules: constructions no character swap can fix. These name a
// span for the round-trip rewrite instruction; `applyMechanicalRepairs`
// never touches them.
// ---------------------------------------------------------------------------

/**
 * Every phrase-based structural rule below runs the English list when the
 * checked text classifies as English or `unknown`, and the Italian list
 * when it classifies as Italian or `unknown` - `unknown` runs both, since a
 * false positive here costs one model round trip and a false negative
 * ships the tell. A match picked up from the Italian side tags its
 * finding's message so a reviewer is not confused about which list
 * matched.
 */
type LangMatch = { start: number; end: number; message?: string };

function scanBilingual(
  text: string,
  enPattern: RegExp,
  itPattern: RegExp,
  message: string,
): LangMatch[] {
  const lang = classifyLanguage(text);
  const out: LangMatch[] = [];
  if (lang !== 'it') {
    for (const m of text.matchAll(enPattern)) {
      const start = m.index ?? 0;
      out.push({ start, end: start + m[0].length });
    }
  }
  if (lang !== 'en') {
    for (const m of text.matchAll(itPattern)) {
      const start = m.index ?? 0;
      out.push({ start, end: start + m[0].length, message: `${message} (Italian)` });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function bilingualWordRule(
  id: string,
  kind: StyleRuleKind,
  message: string,
  enWords: string[],
  itWords: string[],
): Rule {
  const enPattern = new RegExp(`\\b(?:${enWords.map(escapeRegExp).join('|')})\\b`, 'giu');
  const itPattern = new RegExp(`\\b(?:${itWords.map(escapeRegExp).join('|')})\\b`, 'giu');
  return { id, kind, message, scan: (text) => scanBilingual(text, enPattern, itPattern, message) };
}

/** house-style.ts's own opener list, plus its direct Italian counterpart
 * (a reply praising the post it is answering, "Grande post" / "Ottimo
 * punto" and friends) - checked only at the very start of the text (that
 * is what makes them "openers" rather than ordinary phrases to avoid
 * anywhere), so the phrases' ordinary genericness never matters mid-text. */
const FILLER_OPENERS_EN = [
  'Great question',
  'Great post',
  'Hope this finds you well',
  'Thanks for sharing',
  "You're absolutely right",
];

const FILLER_OPENERS_IT = [
  'Grande post',
  'Bel post',
  'Ottimo punto',
  'Complimenti per',
  'Spunto interessante',
  'Grazie per aver condiviso',
  "Assolutamente d'accordo",
  'Concordo pienamente',
];

const FILLER_OPENER_MESSAGE = 'Filler opener: house style bans starting a draft this way.';

const FILLER_OPENER_RULE: Rule = {
  id: 'filler-opener',
  kind: 'structural',
  message: FILLER_OPENER_MESSAGE,
  scan(text) {
    const leading = text.match(/^\s*/u)?.[0].length ?? 0;
    const rest = text.slice(leading);
    const lower = rest.toLowerCase();
    const lang = classifyLanguage(text);
    const candidates: Array<{ phrase: string; italian: boolean }> = [];
    if (lang !== 'it') {
      for (const phrase of FILLER_OPENERS_EN) candidates.push({ phrase, italian: false });
    }
    if (lang !== 'en') {
      for (const phrase of FILLER_OPENERS_IT) candidates.push({ phrase, italian: true });
    }
    for (const { phrase, italian } of candidates) {
      if (lower.startsWith(phrase.toLowerCase())) {
        return [
          {
            start: leading,
            end: leading + phrase.length,
            message: italian ? `${FILLER_OPENER_MESSAGE} (Italian)` : undefined,
          },
        ];
      }
    }
    return [];
  },
};

/** house-style.ts's puffery list, minus "in today's fast-paced world" (its
 * own rule below, since it is a phrase rather than a single word and worth
 * naming on its own in a finding), plus its direct Italian counterparts.
 * "approfondire" is deliberately not here: it is an ordinary Italian verb
 * ("to look into further") that shows up constantly in genuine writing,
 * and only reads as a tell in the stock closing line the wrapup-closer
 * rule below checks for, never as a bare word anywhere in the draft. */
const PUFFERY_WORDS_EN = [
  'leverage',
  'seamless',
  'robust',
  'comprehensive',
  'delve',
  'unlock',
  'elevate',
  'game-changer',
];

const PUFFERY_WORDS_IT = [
  // Both grammatical genders: an Italian adjective agrees with the noun it
  // describes ("una soluzione innovativa" / "un prodotto innovativo"), so a
  // masculine-only literal would miss half of ordinary usage.
  'innovativo',
  'innovativa',
  "all'avanguardia",
  'rivoluzionario',
  'rivoluzionaria',
  'sinergia',
  'valore aggiunto',
  'sfruttare al meglio',
  'game changer',
];

const PUFFERY_MESSAGE = 'Puffery word: house style bans this as a corporate-speak tell.';

const PUFFERY_RULE = bilingualWordRule(
  'puffery',
  'structural',
  PUFFERY_MESSAGE,
  PUFFERY_WORDS_EN,
  PUFFERY_WORDS_IT,
);

const WRAPUP_CLOSERS_EN = [
  'hope this helps',
  'at the end of the day',
  'the bottom line is',
  'happy to chat',
  'let me know if you have any questions',
];

/** Direct Italian counterparts, kept to the same specificity the English
 * list has: a bare "fammi sapere" ("let me know") or "in conclusione" ("in
 * conclusion") is ordinary writing on its own, so only the full closing
 * formula is banned here, matching how specific every English phrase
 * above already is. */
const WRAPUP_CLOSERS_IT = [
  'spero di essere stato utile',
  'fammi sapere se hai domande',
  'resto a disposizione',
  'alla fine della fiera',
];

const WRAPUP_CLOSER_MESSAGE = 'Wrap-up closer: house style bans this as a machine-written tell.';

/**
 * Two more Italian-only closer tells that fire only in closing position -
 * the same words earlier in the text are ordinary writing:
 *   - "cosa ne pensi?" as the literal last sentence (mirrors
 *     RHETORICAL_OPENER_RULE's opener-only gating, at the other end of the
 *     text instead of the start).
 *   - "approfondire" used as the stock "let me know if you'd like to go
 *     deeper" closing verb, checked only within the closing window rather
 *     than banned everywhere (see PUFFERY_WORDS_IT's comment on why it is
 *     not a bare word ban).
 */
const CLOSER_WINDOW_CHARS = 100;
const CLOSING_QUESTION_IT = 'cosa ne pensi?';
const CLOSER_VERB_IT = /\bapprofondire\b/iu;

function closingWindow(text: string): { window: string; offset: number } {
  const trimmed = text.replace(/\s+$/u, '');
  const offset = Math.max(0, trimmed.length - CLOSER_WINDOW_CHARS);
  return { window: trimmed.slice(offset), offset };
}

const WRAPUP_CLOSER_RULE: Rule = {
  id: 'wrapup-closer',
  kind: 'structural',
  message: WRAPUP_CLOSER_MESSAGE,
  scan(text) {
    const out = scanBilingual(
      text,
      new RegExp(`(?:${WRAPUP_CLOSERS_EN.map(escapeRegExp).join('|')})`, 'giu'),
      new RegExp(`(?:${WRAPUP_CLOSERS_IT.map(escapeRegExp).join('|')})`, 'giu'),
      WRAPUP_CLOSER_MESSAGE,
    );
    if (classifyLanguage(text) !== 'en') {
      const { window, offset } = closingWindow(text);
      if (window.toLowerCase().endsWith(CLOSING_QUESTION_IT)) {
        const start = offset + window.length - CLOSING_QUESTION_IT.length;
        out.push({
          start,
          end: offset + window.length,
          message: `${WRAPUP_CLOSER_MESSAGE} (Italian)`,
        });
      }
      const verbMatch = CLOSER_VERB_IT.exec(window);
      if (verbMatch) {
        const start = offset + verbMatch.index;
        out.push({
          start,
          end: start + verbMatch[0].length,
          message: `${WRAPUP_CLOSER_MESSAGE} (Italian)`,
        });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  },
};

/** house-style.ts's "not just X, but Y" / "it's not X, it's Y"
 * constructions, bounded to one clause so the match cannot cross a
 * sentence, plus the direct Italian counterparts: "non solo X ma Y" and
 * "non è X, è Y". "è" is not an ASCII word character, so the Italian half
 * bounds it with a Unicode-letter lookaround instead of `\b` - `\b` never
 * matches next to an accented letter in a JS regex, `u` flag or not. */
const NOT_X_BUT_Y_MESSAGE = '"Not just X but Y" construction: a listed LinkedIn tell.';

const NOT_X_BUT_Y_RULE: Rule = {
  id: 'not-x-but-y',
  kind: 'structural',
  message: NOT_X_BUT_Y_MESSAGE,
  scan: (text) =>
    scanBilingual(
      text,
      /\bnot\s+just\b[^.!?\n]{0,80}?\bbut\b|\bit'?s\s+not\b[^.!?\n]{0,80}?,\s*it'?s\b/giu,
      /\bnon\s+solo\b[^.!?\n]{0,80}?\bma\b|\bnon\s+è(?![\p{L}\p{N}_])[^.!?\n]{0,80}?,\s*è(?![\p{L}\p{N}_])/giu,
      NOT_X_BUT_Y_MESSAGE,
    ),
};

/** A rhetorical question as the very first sentence ("Ever wondered why...?")
 * - a classic LinkedIn opener. Only the opener is checked: a genuine question
 * later in the text is ordinary writing. */
const RHETORICAL_OPENER_RULE: Rule = {
  id: 'rhetorical-question-opener',
  kind: 'structural',
  message: 'Rhetorical-question opener: a listed LinkedIn tell.',
  scan(text) {
    const leading = text.match(/^\s*/u)?.[0].length ?? 0;
    const rest = text.slice(leading);
    const m = rest.match(/^[^.!?\n]{1,140}\?/u);
    if (!m) return [];
    return [{ start: leading, end: leading + m[0].length }];
  },
};

/** house-style.ts's "in today's fast-paced world" cliche, plus its direct
 * Italian counterpart "in un mondo sempre più" ("in an ever more ...
 * world"). No trailing `\b` on the Italian pattern: it ends on "più", and
 * `\b` never matches next to a non-ASCII letter in a JS regex. */
const FAST_PACED_MESSAGE = '"In today\'s fast-paced" cliche: a listed LinkedIn tell.';

const FAST_PACED_RULE: Rule = {
  id: 'fast-paced-cliche',
  kind: 'structural',
  message: FAST_PACED_MESSAGE,
  scan: (text) =>
    scanBilingual(
      text,
      /\bin\s+today'?s\s+fast-paced\b/giu,
      /\bin\s+un\s+mondo\s+sempre\s+pi\u00f9(?![\p{L}\p{N}_])/giu,
      FAST_PACED_MESSAGE,
    ),
};

/** Three or more hashtags in a row (a "hashtag stack"), separated only by
 * whitespace or commas. */
const HASHTAG_STACK_RULE = regexRule(
  'hashtag-stack',
  'structural',
  'Hashtag stack: a listed LinkedIn tell.',
  /#\w+(?:[\s,]+#\w+){2,}/gu,
);

/** A line whose first non-space character is an emoji, used as a bullet. */
const EMOJI_BULLET_RULE = regexRule(
  'emoji-bullet',
  'structural',
  'Emoji used as a bullet point: a listed LinkedIn tell.',
  /^[ \t]*[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]\uFE0F?[ \t]+/gmu,
);

/**
 * A tricolon: three short, comma-separated items closed with an Oxford
 * comma before a conjunction ("faster, cheaper, and better" / "più veloce,
 * più semplice, e più economico"). Bounded to short items (at most four
 * words each) and to one line, so an ordinary sentence that happens to
 * list three things without this shape is not flagged - the counterexample
 * test below is exactly that sentence.
 */
const TRICOLON_ITEM = `\\w[\\w'-]*(?:\\s+\\w[\\w'-]*){0,3}`;
const TRICOLON_MESSAGE = 'Tricolon (rule-of-three list): a listed LinkedIn tell.';

const TRICOLON_RULE: Rule = {
  id: 'tricolon',
  kind: 'structural',
  message: TRICOLON_MESSAGE,
  scan: (text) =>
    scanBilingual(
      text,
      new RegExp(
        `\\b(?:${TRICOLON_ITEM}),\\s*(?:${TRICOLON_ITEM}),\\s*(?:and|or)\\s+${TRICOLON_ITEM}\\b`,
        'giu',
      ),
      new RegExp(
        `\\b(?:${TRICOLON_ITEM}),\\s*(?:${TRICOLON_ITEM}),\\s*(?:e|o)\\s+${TRICOLON_ITEM}\\b`,
        'giu',
      ),
      TRICOLON_MESSAGE,
    ),
};

const STRUCTURAL_RULES: Rule[] = [
  FILLER_OPENER_RULE,
  PUFFERY_RULE,
  WRAPUP_CLOSER_RULE,
  NOT_X_BUT_Y_RULE,
  RHETORICAL_OPENER_RULE,
  FAST_PACED_RULE,
  HASHTAG_STACK_RULE,
  EMOJI_BULLET_RULE,
  TRICOLON_RULE,
];

const ALL_RULES: Rule[] = [...CHARACTER_RULES, ...STRUCTURAL_RULES];

/**
 * Runs every rule against `text` and returns every finding, earliest span
 * first. Unconditional: no argument here can turn a rule off, and no rule
 * short-circuits because another one already matched.
 */
export function checkStyle(text: string): StyleFinding[] {
  const findings: StyleFinding[] = [];
  for (const rule of ALL_RULES) {
    for (const { start, end, repair, message } of rule.scan(text)) {
      findings.push({
        ruleId: rule.id,
        kind: rule.kind,
        message: message ?? rule.message,
        span: text.slice(start, end),
        start,
        end,
        repair,
      });
    }
  }
  return findings.sort((a, b) => a.start - b.start);
}

/**
 * Fixes every character-level finding mechanically - no model call, no
 * judgement, one deterministic swap per banned code point. Structural
 * findings are left exactly as they were; this function never rewrites a
 * construction, only punctuation.
 */
export function applyMechanicalRepairs(text: string): string {
  const findings = checkStyle(text).filter((f) => f.kind === 'character' && f.repair != null);
  if (findings.length === 0) return text;
  // Right-to-left so an earlier repair's length change never invalidates a
  // later finding's offsets.
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, f.start) + f.repair + out.slice(f.end);
  }
  return out;
}

/** The line the round-trip rewrite instruction asks the model to answer
 * after. Mirrors `shared/src/assist/envelope.ts`'s DRAFT_MARKER: the model is
 * not trusted to reply with "nothing else", so the worst case of a marker
 * never arriving is treated as a failed rewrite, not a rewrite that leaked a
 * preamble into the draft. */
export const REWRITE_MARKER = '---PITCHBOX-STYLE-REWRITE---';

/**
 * Builds the single targeted-rewrite instruction: the draft, the exact spans
 * that still fail, and nothing else asked of the model. Sent at most once
 * per draft (`enforceHouseStyle` never loops).
 */
export function buildRewriteInstruction(text: string, findings: StyleFinding[]): string {
  const items = findings.map((f) => `- ${f.ruleId}: "${f.span}" - ${f.message}`).join('\n');
  return [
    'This draft fails a deterministic house-style check on exactly the points',
    'listed below. Rewrite only what is needed to fix them. Every other word,',
    'the language it is written in, and its length stay as they are.',
    '',
    'Draft:',
    text,
    '',
    'Points to fix:',
    items,
    '',
    `Reply with ${REWRITE_MARKER} alone on its own line, then the corrected`,
    'draft and nothing else after it: no preamble, no quotes around it, no',
    'notes.',
  ].join('\n');
}

/** Extracts the corrected draft from a rewrite response. `null` on anything
 * short of a clean match - a missing marker or an empty tail - so a
 * non-compliant reply can never leak partial or reasoning text into a draft
 * (same worst-case-is-nothing design as `splitSuggestion`). */
export function extractRewrite(response: string): string | null {
  const at = response.indexOf(REWRITE_MARKER);
  if (at === -1) return null;
  const rewritten = response.slice(at + REWRITE_MARKER.length).trim();
  return rewritten.length > 0 ? rewritten : null;
}

export interface HouseStyleResult {
  /** The best text `enforceHouseStyle` could produce: mechanically repaired,
   * and rewritten once more if a rewrite function was given and needed. */
  text: string;
  /** Structural findings still present in `text`. Empty means the draft is
   * clean. Never dropped silently: a caller with nowhere else to show these
   * persists or displays them rather than accepting `text` as-is. */
  findings: StyleFinding[];
  /** True when a character-level rule actually changed the text. */
  repaired: boolean;
  /** True when a rewrite function was called (whether or not it left
   * findings behind). */
  rewriteAttempted: boolean;
}

/**
 * Asks a caller-supplied function to run the targeted-rewrite instruction
 * against a live model and hand back its raw reply, unparsed. Returning
 * `null` (or throwing) is a failed round trip, handled the same way as no
 * rewrite function at all. Extraction of the corrected draft from the reply
 * happens inside `enforceHouseStyle`, not here: the same
 * worst-case-is-nothing marker parsing every caller gets for free, instead
 * of every caller re-implementing `extractRewrite` and one of them getting
 * it wrong.
 */
export type RewriteFn = (text: string, findings: StyleFinding[]) => Promise<string | null>;

/**
 * The full repair pass, in the order #572 specifies:
 *   1. check the produced draft;
 *   2. fix every character-level finding mechanically;
 *   3. if a structural finding remains, send it back to the model as a
 *      targeted rewrite instruction, once, and check again;
 *   4. if it still fails, return it with the finding attached rather than
 *      silently accepting it.
 *
 * `rewrite` is optional because not every caller has a live model to round
 * -trip against (`cli/src/commands/drafts.ts`'s batch insert runs after the
 * agent turn that wrote the draft has already exited). Omitting it is not a
 * way to skip the check: mechanical repair still runs, and any structural
 * finding that would have gone to the model comes back in `findings`
 * instead, unresolved but visible.
 */
export async function enforceHouseStyle(
  text: string,
  rewrite?: RewriteFn,
): Promise<HouseStyleResult> {
  const mechanical = applyMechanicalRepairs(text);
  const repaired = mechanical !== text;
  const structural = checkStyle(mechanical).filter((f) => f.kind === 'structural');

  if (structural.length === 0) {
    return { text: mechanical, findings: [], repaired, rewriteAttempted: false };
  }
  if (!rewrite) {
    return { text: mechanical, findings: structural, repaired, rewriteAttempted: false };
  }

  let rawReply: string | null;
  try {
    rawReply = await rewrite(mechanical, structural);
  } catch {
    rawReply = null;
  }
  const rewritten = rawReply != null ? extractRewrite(rawReply) : null;
  if (!rewritten) {
    return { text: mechanical, findings: structural, repaired, rewriteAttempted: true };
  }

  // The rewrite is itself model output: run the same mechanical pass on it
  // (a model asked to fix a tricolon can just as easily reintroduce an em
  // dash) and check again before trusting it.
  const rewrittenRepaired = applyMechanicalRepairs(rewritten);
  const remaining = checkStyle(rewrittenRepaired).filter((f) => f.kind === 'structural');
  return {
    text: rewrittenRepaired,
    findings: remaining,
    repaired: repaired || rewrittenRepaired !== rewritten,
    rewriteAttempted: true,
  };
}
