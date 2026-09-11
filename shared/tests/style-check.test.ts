import { describe, expect, it } from 'vitest';
import {
  applyMechanicalRepairs,
  buildRewriteInstruction,
  checkStyle,
  enforceHouseStyle,
  extractRewrite,
  REWRITE_MARKER,
  type StyleFinding,
} from '../src/style-check.js';
import { HOUSE_STYLE_SECTION } from '../src/house-style.js';
import { classifyLanguage } from '../src/assist/voice-profile.js';

function ruleIds(findings: StyleFinding[]): string[] {
  return findings.map((f) => f.ruleId);
}

describe('checkStyle: character-level rules, one test per rule with a passing counterexample', () => {
  it('flags an em dash and leaves an ordinary hyphenated word alone', () => {
    expect(ruleIds(checkStyle('I built this\u2014it works.'))).toContain('em-dash');
    // Counterexample: a plain ASCII hyphen is never a violation.
    expect(ruleIds(checkStyle('A state-of-the-art tool.'))).not.toContain('em-dash');
  });

  it('flags an en dash between words but not a numeric range', () => {
    expect(ruleIds(checkStyle('fast \u2013 but simple.'))).toContain('en-dash-between-words');
    // Counterexample: "2019–2021" is a range, not "between words".
    expect(ruleIds(checkStyle('Founded 2019\u20132021.'))).not.toContain('en-dash-between-words');
  });

  it('flags curly double quotes but not straight ones', () => {
    expect(ruleIds(checkStyle('She said \u201Chello\u201D.'))).toContain('curly-quote');
    expect(ruleIds(checkStyle('She said "hello".'))).not.toContain('curly-quote');
  });

  it('flags a curly apostrophe but not a straight one', () => {
    expect(ruleIds(checkStyle('It\u2019s ready.'))).toContain('curly-apostrophe');
    expect(ruleIds(checkStyle("It's ready."))).not.toContain('curly-apostrophe');
  });

  it('flags the single-character ellipsis but not three ASCII dots', () => {
    expect(ruleIds(checkStyle('Wait\u2026 really?'))).toContain('ellipsis-char');
    expect(ruleIds(checkStyle('Wait... really?'))).not.toContain('ellipsis-char');
  });

  it('flags a non-breaking space but not an ordinary space', () => {
    expect(ruleIds(checkStyle('two\u00A0words'))).toContain('nbsp');
    expect(ruleIds(checkStyle('two words'))).not.toContain('nbsp');
  });
});

describe('checkStyle: structural rules, one test per rule with a passing counterexample', () => {
  it('flags a filler opener only at the start of the draft', () => {
    expect(ruleIds(checkStyle('Great question, thanks for asking.'))).toContain('filler-opener');
    // Counterexample: the same words, not as an opener, are not flagged.
    expect(
      ruleIds(checkStyle('I looked into it and yes, that is a great question to raise.')),
    ).not.toContain('filler-opener');
  });

  it('flags a puffery word but not an ordinary use of a similar word', () => {
    expect(ruleIds(checkStyle('This will leverage our existing stack.'))).toContain('puffery');
    // Counterexample: none of the banned words appear.
    expect(ruleIds(checkStyle('This will use our existing stack.'))).not.toContain('puffery');
  });

  it('flags a wrap-up closer but not an ordinary sentence', () => {
    expect(ruleIds(checkStyle('At the end of the day, it shipped.'))).toContain('wrapup-closer');
    expect(ruleIds(checkStyle('It shipped on Tuesday.'))).not.toContain('wrapup-closer');
  });

  it('flags "not just X but Y" but not a plain contrast', () => {
    expect(ruleIds(checkStyle('This is not just a bug, but a design flaw.'))).toContain(
      'not-x-but-y',
    );
    expect(ruleIds(checkStyle('This is a bug, and it is a design flaw.'))).not.toContain(
      'not-x-but-y',
    );
  });

  it('flags a rhetorical-question opener but not a mid-text question', () => {
    expect(ruleIds(checkStyle('Ever wondered why builds are slow?'))).toContain(
      'rhetorical-question-opener',
    );
    expect(ruleIds(checkStyle('The build was slow. Why? A missing cache key.'))).not.toContain(
      'rhetorical-question-opener',
    );
  });

  it('flags the "today\'s fast-paced" cliche but not an ordinary mention of pace', () => {
    expect(ruleIds(checkStyle("In today's fast-paced market, speed matters."))).toContain(
      'fast-paced-cliche',
    );
    expect(ruleIds(checkStyle('The market moves fast these days.'))).not.toContain(
      'fast-paced-cliche',
    );
  });

  it('flags a hashtag stack but not a single hashtag', () => {
    expect(ruleIds(checkStyle('Shipped it. #growth #sales #b2b'))).toContain('hashtag-stack');
    expect(ruleIds(checkStyle('Shipped it. #shipping'))).not.toContain('hashtag-stack');
  });

  it('flags an emoji used as a bullet but not an emoji inside a sentence', () => {
    expect(ruleIds(checkStyle('\uD83D\uDE80 Ship faster'))).toContain('emoji-bullet');
    expect(ruleIds(checkStyle('We shipped it \uD83D\uDE80 today.'))).not.toContain('emoji-bullet');
  });

  it('flags a tricolon but not a plain two-item list', () => {
    expect(ruleIds(checkStyle('It is faster, cheaper, and better.'))).toContain('tricolon');
    // Counterexample: a rule-of-three needs the shape, not just three words
    // anywhere in the sentence - a two-item list is ordinary writing.
    expect(ruleIds(checkStyle('It is faster and cheaper.'))).not.toContain('tricolon');
  });
});

describe('checkStyle: Italian counterparts of the structural rules (classifyLanguage picks the list)', () => {
  const italianCases: Array<{ ruleId: string; fires: string; doesNotFire: string }> = [
    {
      ruleId: 'filler-opener',
      fires: 'Grande post, davvero un ottimo lavoro da parte del team.',
      doesNotFire: 'Il team ha lavorato bene su questo argomento nelle ultime settimane.',
    },
    {
      ruleId: 'puffery',
      fires: 'La nostra piattaforma è davvero innovativa e pronta per il mercato.',
      doesNotFire: 'La nostra piattaforma è pronta per il mercato da qualche settimana.',
    },
    {
      ruleId: 'wrapup-closer',
      fires: 'Il progetto è terminato in orario. Resto a disposizione per qualsiasi chiarimento.',
      doesNotFire: 'Il progetto è terminato in orario e il cliente ha già dato un primo riscontro.',
    },
    {
      ruleId: 'not-x-but-y',
      fires: "Questo non è un problema, è un'opportunità da cogliere subito.",
      doesNotFire: 'Questo è un problema serio, ma il team lo risolverà entro venerdì.',
    },
    {
      ruleId: 'fast-paced-cliche',
      fires: 'In un mondo sempre più connesso, la velocità di risposta conta davvero.',
      doesNotFire: 'Il mondo del lavoro cambia sempre più velocemente di quanto pensassimo.',
    },
    {
      ruleId: 'tricolon',
      fires: 'Il prodotto è veloce, semplice, e affidabile.',
      doesNotFire: 'Il prodotto è veloce e affidabile.',
    },
  ];

  it.each(italianCases)(
    '$ruleId fires on the Italian construction, tags the finding, and not on ordinary Italian prose',
    ({ ruleId, fires, doesNotFire }) => {
      const found = checkStyle(fires);
      expect(ruleIds(found)).toContain(ruleId);
      const hit = found.find((f) => f.ruleId === ruleId);
      expect(hit?.message).toContain('(Italian)');
      expect(ruleIds(checkStyle(doesNotFire))).not.toContain(ruleId);
    },
  );

  it('flags "cosa ne pensi?" only when it is the closing sentence, not mid-text', () => {
    const closing = 'Abbiamo appena lanciato la nuova funzione di ricerca. Cosa ne pensi?';
    expect(ruleIds(checkStyle(closing))).toContain('wrapup-closer');
    const midText =
      'Cosa ne pensi? Fammi sapere entro la fine della settimana quando riesci a provarla di persona con il resto del team.';
    expect(ruleIds(checkStyle(midText))).not.toContain('wrapup-closer');
  });

  it('flags "approfondire" as a closing verb only near the end of the draft, not as a general word ban', () => {
    const closing =
      'Abbiamo condiviso i risultati del test interno. Fammi sapere se vuoi approfondire.';
    expect(ruleIds(checkStyle(closing))).toContain('wrapup-closer');
    // "approfondire" is an ordinary Italian verb far from the end of the
    // draft here - the puffery list deliberately excludes it as a bare
    // word ban, and the closer check is gated to the closing window.
    const midText =
      'Vorrei approfondire questo argomento in un articolo dedicato nelle prossime settimane, perché il team ha raccolto moltissimi dati interessanti durante lo sviluppo del progetto, e sarebbe un peccato non condividerli con calma.';
    expect(ruleIds(checkStyle(midText))).not.toContain('wrapup-closer');
  });
});

describe('checkStyle: the check is not conditional', () => {
  it('runs every rule regardless of draft length', () => {
    // A one-character draft still gets checked; there is no length guard.
    expect(checkStyle('\u2014')).toHaveLength(1);
    expect(checkStyle('')).toEqual([]);
  });

  it('has no flag or option that turns any rule off', () => {
    // The only optional argument, `expectedLanguage` (LOR-291), selects
    // which bilingual phrase list a structural rule reads - it can never
    // make a rule stop running. A character-level rule ignores it outright
    // (same finding count with no pin, an English pin, or an Italian pin),
    // and a bilingual structural rule still fires on its own language's
    // list regardless of what, if anything, was passed.
    expect(checkStyle('\u2014')).toHaveLength(1);
    expect(checkStyle('\u2014', 'en')).toHaveLength(1);
    expect(checkStyle('\u2014', 'it')).toHaveLength(1);
    expect(ruleIds(checkStyle('Sinergia forte, davvero speciale.', 'it'))).toContain('puffery');
    expect(ruleIds(checkStyle('This will leverage our stack.', 'en'))).toContain('puffery');
  });
});

describe('checkStyle: an explicit expectedLanguage pin overrides classifyLanguage (LOR-291)', () => {
  // A campaign pinned to a language (`campaign.config.voice.language`,
  // LOR-265) can produce a short, genuinely mixed body classifyLanguage
  // reads as `unknown` - LOR-280 measured this on roughly a third of short
  // Italian text. This body is a realistic shape for that: Italian
  // business copy that borrows an English term ("leverage") the same way
  // it uses a real Italian one for the same idea ("sinergia"). The
  // classifier's own read is asserted first, not assumed, since the whole
  // point of this case is that it gives no reliable answer on its own.
  const mixedBody = 'Sinergia forte qui, complimenti, leverage forte.';

  it('classifyLanguage alone reads this body as unknown', () => {
    expect(classifyLanguage(mixedBody)).toBe('unknown');
  });

  it('is checked against the Italian rules when the campaign is pinned to Italian', () => {
    const pinned = checkStyle(mixedBody, 'it');
    const puffery = pinned.filter((f) => f.ruleId === 'puffery');
    // Exactly the Italian-list finding: "leverage" is a real English-list
    // phrase too, and would be a second finding here if a pin did not
    // exclude that list outright rather than merely deprioritizing it.
    expect(puffery).toHaveLength(1);
    expect(puffery[0]?.span).toBe('Sinergia');
    expect(puffery[0]?.message).toContain('(Italian)');
  });

  it('is checked against both lists when there is no pin, exactly as before this parameter existed', () => {
    const unpinned = checkStyle(mixedBody);
    const spans = unpinned.filter((f) => f.ruleId === 'puffery').map((f) => f.span);
    // Unchanged fallback: `unknown` still runs both phrase lists, so the
    // same body that gets exactly one finding when pinned gets two with
    // nothing to override the classifier's non-answer.
    expect(spans).toContain('Sinergia');
    expect(spans).toContain('leverage');
  });

  it('a pin to the other language reads the same body by its own list, never the classifier', () => {
    const pinnedEn = checkStyle(mixedBody, 'en');
    const spans = pinnedEn.filter((f) => f.ruleId === 'puffery').map((f) => f.span);
    expect(spans).toEqual(['leverage']);
  });
});

describe('checkStyle: accents and diacritics are never touched', () => {
  it('leaves Italian and French accented letters untouched by every rule', () => {
    const text = "Il team più veloce c'è già, e il caffè è pronto. Voilà, ça y est déjà.";
    expect(checkStyle(text)).toEqual([]);
    expect(applyMechanicalRepairs(text)).toBe(text);
  });

  it('repairs banned punctuation next to accented text without altering the accents', () => {
    const text = 'Il pi\u00F9 veloce \u2014 e gi\u00E0 pronto \u2014 \u00E8 qui.';
    const repaired = applyMechanicalRepairs(text);
    expect(repaired).toBe('Il pi\u00F9 veloce, e gi\u00E0 pronto, \u00E8 qui.');
    // Every accented character survives byte-for-byte.
    expect(repaired).toContain('pi\u00F9');
    expect(repaired).toContain('gi\u00E0');
    expect(repaired).toContain('\u00E8 qui');
  });

  it('matches an Italian phrase carrying an accent and applyMechanicalRepairs leaves it untouched', () => {
    const text = 'In un mondo sempre più connesso \u2014 la velocità conta davvero.';
    const findings = checkStyle(text);
    const fastPaced = findings.find((f) => f.ruleId === 'fast-paced-cliche');
    expect(fastPaced?.span).toBe('In un mondo sempre più');
    expect(fastPaced?.message).toContain('(Italian)');
    const repaired = applyMechanicalRepairs(text);
    // The em dash is mechanically repaired; the accented phrase this rule
    // matched, and every other accented letter in the text, survive
    // byte-for-byte - only the character-level finding was ever touched.
    expect(repaired).toBe('In un mondo sempre più connesso, la velocità conta davvero.');
    expect(repaired).toContain('più');
    expect(repaired).toContain('velocità');
  });
});

describe('applyMechanicalRepairs: exact output, nothing else changed', () => {
  it("turns a real draft's em dash into a comma and changes nothing else", () => {
    const draft = 'We shipped the migration last week\u2014it ran clean on every table we tested.';
    expect(applyMechanicalRepairs(draft)).toBe(
      'We shipped the migration last week, it ran clean on every table we tested.',
    );
  });
});

describe('enforceHouseStyle: the repair pass, in order', () => {
  it('proves the repair pass bites: a deliberately AI-sounding draft is caught rule by rule', async () => {
    const aiSounding =
      "Great question! In today's fast-paced world, this is not just a feature\u2014it's " +
      'a game-changer, but a real one.\n' +
      "It's faster, cheaper, and better.\n" +
      '\uD83D\uDE80 Ship it today. #growth #sales #b2b\n' +
      'At the end of the day, hope this helps.';
    const result = await enforceHouseStyle(aiSounding);
    const foundIds = ruleIds(result.findings);
    expect(foundIds).toContain('filler-opener');
    expect(foundIds).toContain('fast-paced-cliche');
    expect(foundIds).toContain('not-x-but-y');
    expect(foundIds).toContain('puffery'); // game-changer
    expect(foundIds).toContain('tricolon');
    expect(foundIds).toContain('emoji-bullet');
    expect(foundIds).toContain('hashtag-stack');
    expect(foundIds).toContain('wrapup-closer');
    // The em dash is a character-level finding: mechanically repaired, so it
    // is gone from the returned text and never appears in the leftover
    // findings.
    expect(result.text).not.toContain('\u2014');
    expect(ruleIds(result.findings)).not.toContain('em-dash');
    expect(result.repaired).toBe(true);
  });

  it('proves a clean human draft passes untouched', async () => {
    const clean =
      'I spent Tuesday afternoon on the migration and it broke twice before it worked. ' +
      "Not glamorous, but it's done now.";
    const result = await enforceHouseStyle(clean);
    expect(result.text).toBe(clean);
    expect(result.findings).toEqual([]);
    expect(result.repaired).toBe(false);
    expect(result.rewriteAttempted).toBe(false);
  });

  it('sends a structural finding back to the model exactly once and accepts a clean rewrite', async () => {
    const original = 'Ever wondered why builds are slow? A missing cache key, mostly.';
    let calls = 0;
    const rewrite = async (text: string, findings: StyleFinding[]) => {
      calls += 1;
      expect(text).toBe(original);
      expect(ruleIds(findings)).toEqual(['rhetorical-question-opener']);
      return `${REWRITE_MARKER}\nBuilds were slow because of a missing cache key, mostly.`;
    };
    const result = await enforceHouseStyle(original, rewrite);
    expect(calls).toBe(1);
    expect(result.rewriteAttempted).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.text).toBe('Builds were slow because of a missing cache key, mostly.');
  });

  it('shows the finding rather than silently accepting a draft the rewrite could not fix', async () => {
    const original = 'Ever wondered why builds are slow? Great question, honestly.';
    // The rewrite fixes the rhetorical opener but still opens with a filler
    // phrase - a rewrite that only partially complies.
    const rewrite = async () =>
      `${REWRITE_MARKER}\nGreat question, builds are slow because of a missing cache key.`;
    const result = await enforceHouseStyle(original, rewrite);
    expect(result.rewriteAttempted).toBe(true);
    // The rewrite fixed one thing and reintroduced the other: the finding
    // travels with the text instead of being dropped.
    expect(ruleIds(result.findings)).toContain('filler-opener');
    expect(ruleIds(result.findings)).not.toContain('rhetorical-question-opener');
    expect(result.text).toBe('Great question, builds are slow because of a missing cache key.');
  });

  it('treats a non-compliant rewrite reply (no marker) as a failed rewrite, not a draft', async () => {
    const original = 'Ever wondered why builds are slow?';
    const rewrite = async () => 'Sure, here is the fix: Builds were slow.';
    const result = await enforceHouseStyle(original, rewrite);
    expect(result.rewriteAttempted).toBe(true);
    // Falls back to the mechanically-repaired original, findings still shown.
    expect(result.text).toBe(original);
    expect(ruleIds(result.findings)).toContain('rhetorical-question-opener');
  });

  it('still runs the mechanical + structural check with no rewrite function at all', async () => {
    const original = 'Great question\u2014ever wondered why?';
    const result = await enforceHouseStyle(original);
    expect(result.rewriteAttempted).toBe(false);
    expect(result.repaired).toBe(true);
    expect(result.text).not.toContain('\u2014');
    const foundIds = ruleIds(result.findings);
    expect(foundIds).toContain('filler-opener');
    expect(foundIds).toContain('rhetorical-question-opener');
  });

  it('threads expectedLanguage into the structural check, same as checkStyle (LOR-291)', async () => {
    const mixedBody = 'Sinergia forte qui, complimenti, leverage forte.';
    const pinned = await enforceHouseStyle(mixedBody, undefined, 'it');
    const puffery = pinned.findings.filter((f) => f.ruleId === 'puffery');
    expect(puffery).toHaveLength(1);
    expect(puffery[0]?.span).toBe('Sinergia');
    const unpinned = await enforceHouseStyle(mixedBody);
    expect(unpinned.findings.filter((f) => f.ruleId === 'puffery')).toHaveLength(2);
  });
});

describe('buildRewriteInstruction / extractRewrite', () => {
  it('names every remaining span once in the instruction', () => {
    const findings = checkStyle('Ever wondered why? Great question.');
    const instruction = buildRewriteInstruction('Ever wondered why? Great question.', findings);
    for (const f of findings) {
      expect(instruction).toContain(f.span);
      expect(instruction).toContain(f.ruleId);
    }
    expect(instruction).toContain(REWRITE_MARKER);
  });

  it('extracts only the text after the marker', () => {
    expect(extractRewrite(`blah blah\n${REWRITE_MARKER}\nThe fixed draft.`)).toBe(
      'The fixed draft.',
    );
  });

  it('returns null when the marker never arrives', () => {
    expect(extractRewrite('The model just answered in prose.')).toBeNull();
  });

  it('returns null when the marker arrives with nothing after it', () => {
    expect(extractRewrite(`some text\n${REWRITE_MARKER}\n   `)).toBeNull();
  });
});

describe('house-style.ts stays in sync with the checker', () => {
  // house-style.ts is the prompt-facing prose; these rule lists are the
  // code-facing enforcement of the same rules. A phrase that exists in one
  // and not the other is exactly the kind of drift the checker exists to
  // prevent, so assert every phrase-based rule's vocabulary is still named
  // in the prose.
  const phrasesThatMustAppearInHouseStyle = [
    'Great question',
    'Hope this finds you well',
    'leverage',
    'game-changer',
    'hope this helps',
    'the bottom line is',
    'not just X',
  ];

  it.each(phrasesThatMustAppearInHouseStyle)('house style prose still mentions "%s"', (phrase) => {
    expect(HOUSE_STYLE_SECTION.toLowerCase()).toContain(phrase.toLowerCase());
  });
});
