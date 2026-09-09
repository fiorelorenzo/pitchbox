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
// Accent and diacritic characters are never touched by any rule below: every
// pattern targets a specific punctuation code point or an ASCII phrase, never
// a broad character class that could catch a letter. `shared/tests
// /style-check.test.ts` asserts this directly against Italian and French text
// carrying "è", "più", "café" and friends.

export type StyleRuleKind = 'character' | 'structural';

export interface StyleFinding {
  /** Stable id, e.g. "em-dash", "tricolon". Never renamed once shipped: a
   * caller may persist it (drafts.metadata). */
  ruleId: string;
  kind: StyleRuleKind;
  /** One sentence, written for the operator who sees the finding, not for a
   * log. */
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
  /** Every match in `text`, earliest first, never overlapping. */
  scan(text: string): Array<{ start: number; end: number; repair?: string }>;
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

function phraseRule(id: string, kind: StyleRuleKind, message: string, phrases: string[]): Rule {
  const pattern = new RegExp(`(?:${phrases.map(escapeRegExp).join('|')})`, 'giu');
  return regexRule(id, kind, message, pattern);
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

/** house-style.ts's own opener list, checked only at the very start of the
 * text (that is what makes them "openers" rather than ordinary phrases to
 * avoid anywhere). */
const FILLER_OPENERS = [
  'Great question',
  'Great post',
  'Hope this finds you well',
  'Thanks for sharing',
  "You're absolutely right",
];

const FILLER_OPENER_RULE: Rule = {
  id: 'filler-opener',
  kind: 'structural',
  message: 'Filler opener: house style bans starting a draft this way.',
  scan(text) {
    const leading = text.match(/^\s*/u)?.[0].length ?? 0;
    const rest = text.slice(leading);
    const lower = rest.toLowerCase();
    for (const phrase of FILLER_OPENERS) {
      if (lower.startsWith(phrase.toLowerCase())) {
        return [{ start: leading, end: leading + phrase.length }];
      }
    }
    return [];
  },
};

/** house-style.ts's puffery list, minus "in today's fast-paced world" (its
 * own rule below, since it is a phrase rather than a single word and worth
 * naming on its own in a finding). */
const PUFFERY_WORDS = [
  'leverage',
  'seamless',
  'robust',
  'comprehensive',
  'delve',
  'unlock',
  'elevate',
  'game-changer',
];

const PUFFERY_RULE: Rule = regexRule(
  'puffery',
  'structural',
  'Puffery word: house style bans this as a corporate-speak tell.',
  new RegExp(`\\b(?:${PUFFERY_WORDS.map(escapeRegExp).join('|')})\\b`, 'giu'),
);

const WRAPUP_CLOSERS = [
  'hope this helps',
  'at the end of the day',
  'the bottom line is',
  'happy to chat',
  'let me know if you have any questions',
];

const WRAPUP_CLOSER_RULE = phraseRule(
  'wrapup-closer',
  'structural',
  'Wrap-up closer: house style bans this as a machine-written tell.',
  WRAPUP_CLOSERS,
);

/** house-style.ts's "not just X, but Y" / "it's not X, it's Y" constructions,
 * bounded to one clause so the match cannot cross a sentence. */
const NOT_X_BUT_Y_RULE = regexRule(
  'not-x-but-y',
  'structural',
  '"Not just X but Y" construction: a listed LinkedIn tell.',
  /\bnot\s+just\b[^.!?\n]{0,80}?\bbut\b|\bit'?s\s+not\b[^.!?\n]{0,80}?,\s*it'?s\b/giu,
);

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

const FAST_PACED_RULE = regexRule(
  'fast-paced-cliche',
  'structural',
  '"In today\'s fast-paced" cliche: a listed LinkedIn tell.',
  /\bin\s+today'?s\s+fast-paced\b/giu,
);

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
 * comma before "and"/"or" ("faster, cheaper, and better"). Bounded to short
 * items (at most four words each) and to one line, so an ordinary sentence
 * that happens to list three things without this shape is not flagged - the
 * counterexample test below is exactly that sentence.
 */
const TRICOLON_RULE = regexRule(
  'tricolon',
  'structural',
  'Tricolon (rule-of-three list): a listed LinkedIn tell.',
  /\b(?:\w[\w'-]*(?:\s+\w[\w'-]*){0,3}),\s*(?:\w[\w'-]*(?:\s+\w[\w'-]*){0,3}),\s*(?:and|or)\s+\w[\w'-]*(?:\s+\w[\w'-]*){0,3}\b/giu,
);

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
    for (const { start, end, repair } of rule.scan(text)) {
      findings.push({
        ruleId: rule.id,
        kind: rule.kind,
        message: rule.message,
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
