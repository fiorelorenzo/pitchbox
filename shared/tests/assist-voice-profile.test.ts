import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  measureVoiceCorpus,
  measureVoiceCorpusByGenre,
  describeVoiceProfile,
  describeVoiceProfileForGenre,
  measureOneText,
  classifyLanguage,
  IT_STOPWORDS_GLOBAL,
  measureEditSignature,
  describeEditSignature,
  hasEditSignatureContent,
  MIN_ITEMS_TO_DERIVE,
  MIN_EDIT_PAIRS_TO_DERIVE,
  EMPTY_RHYTHM,
  EMPTY_PUNCTUATION,
  EMPTY_SHAPE,
  EMPTY_VOICE_MARKERS,
  EMPTY_LEXICON,
  EMPTY_LANGUAGE,
  EMPTY_EDIT_SIGNATURE,
  type VoiceCorpusItem,
  type VoiceCorpusItemGenre,
  type VoiceMeasurement,
  type EditPair,
} from '../src/assist/voice-profile.js';

// #407: the operator's own voice, derived from what they have actually
// written rather than shipped as a raw list of captured posts. A
// measurement, not a model call, for the reasons `assist/register.ts` (#406)
// already established for the room's half of the mix - what is worth
// pinning here is the corpus-level version of the same discipline: a corpus
// too small says nothing, a trait or phrase has to repeat across separate
// pieces of writing to count as a habit, and excluding a piece of writing
// changes what comes out.
//
// #570 extends this file past openings/closings/reused words into six more
// axes - rhythm, punctuation, shape, voice markers, lexicon, language - each
// with its own fixture built to make a specific, hand-checkable claim: not
// "the code runs" but "this exact corpus produces this exact number".

const SHORT_FIRST_PERSON = [
  'I shipped the new dashboard today. It took longer than I hoped. The team is happy with it now.',
  "I fixed the flaky test suite this week. It was harder than expected. My team is relieved it's done.",
  'I wrapped up the migration this morning. It went smoother than planned. We are all glad it is finished.',
];

const LONG_IMPERSONAL = [
  'The dashboard redesign shipped this week after several rounds of internal review and testing across every team involved in the rollout process.',
  'The onboarding flow moved to a single guided wizard after customer interviews revealed the previous multi-page form confused nearly half of new signups every single week.',
];

function corpusOf(texts: string[]): VoiceCorpusItem[] {
  return texts.map((text, i) => ({ id: i + 1, kind: 'voice_sample' as const, text }));
}

describe('measureVoiceCorpus', () => {
  it('says nothing about a corpus too small to derive anything, but still counts it', () => {
    const corpus = corpusOf([
      'Shipped the new search today, took three tries to get it right.',
      'Thanks for the feedback, I will look into it this week.',
    ]);
    expect(corpus.length).toBeLessThan(MIN_ITEMS_TO_DERIVE);
    const m = measureVoiceCorpus(corpus);
    expect(m.measurable).toBe(false);
    expect(m.itemCount).toBe(2);
    expect(m.wordCount).toBeGreaterThan(0);
    expect(m.traits).toEqual([]);
    expect(m.openings).toEqual([]);
    expect(m.rhythm).toEqual(EMPTY_RHYTHM);
    expect(m.punctuation).toEqual(EMPTY_PUNCTUATION);
    expect(m.shape).toEqual(EMPTY_SHAPE);
    expect(m.voiceMarkers).toEqual(EMPTY_VOICE_MARKERS);
    expect(m.lexicon).toEqual(EMPTY_LEXICON);
    expect(m.language).toEqual(EMPTY_LANGUAGE);
    expect(describeVoiceProfile(m)).toBeNull();
  });

  it('reports only the trait a clear majority of the corpus shares, not one two of five happen to have', () => {
    const m = measureVoiceCorpus(corpusOf([...SHORT_FIRST_PERSON, ...LONG_IMPERSONAL]));
    expect(m.measurable).toBe(true);
    expect(m.traits).toContain('first-person');
    expect(m.traits).toContain('short-sentences');
    // Two of five is not a majority: the minority register must not appear
    // alongside the one that actually dominates.
    expect(m.traits).not.toContain('impersonal');
    expect(m.traits).not.toContain('long-sentences');
  });

  it('is deterministic: the same corpus measured twice produces byte-identical output', () => {
    const corpus = corpusOf([...SHORT_FIRST_PERSON, ...LONG_IMPERSONAL]);
    const first = measureVoiceCorpus(corpus);
    const second = measureVoiceCorpus(corpus);
    expect(second).toEqual(first);
  });

  describe('recurring openings', () => {
    // Six items: three open on "Just shipped", three do not. Sized so that
    // dropping two of the three still leaves a corpus large enough to
    // derive something (this isolates the phrase's own repeat count from
    // the separate "corpus too small" cutoff).
    const withRepeat: VoiceCorpusItem[] = [
      {
        id: 1,
        kind: 'voice_sample',
        text: 'Just shipped campaign search today. Took three tries to get the ranking right.',
      },
      {
        id: 2,
        kind: 'message',
        text: 'Just shipped the new onboarding flow after two weeks of quiet work on it.',
      },
      {
        id: 3,
        kind: 'draft',
        text: 'Just shipped a fix for the flaky test suite, small change, big relief for the team.',
      },
      {
        id: 4,
        kind: 'template',
        text: 'Excited to announce our new pricing page is live, let me know what you think.',
      },
      {
        id: 5,
        kind: 'message',
        text: 'Working through customer interviews this week, learned a lot about pricing sensitivity.',
      },
      {
        id: 6,
        kind: 'draft',
        text: 'Wrapped up the migration this morning, the team should notice a real speed difference.',
      },
    ];

    it('finds a phrase that opens at least a tenth of the corpus', () => {
      const m = measureVoiceCorpus(withRepeat);
      expect(m.openings).toContain('Just shipped');
    });

    it('excluding the items that shared it drops the phrase - the corpus decides, not a helper', () => {
      const withoutTwo = withRepeat.filter((c) => c.id !== 1 && c.id !== 3);
      expect(withoutTwo.length).toBeGreaterThanOrEqual(MIN_ITEMS_TO_DERIVE);
      const m = measureVoiceCorpus(withoutTwo);
      expect(m.openings).not.toContain('Just shipped');
    });
  });

  it('finds a closing phrase repeated across separate items', () => {
    const corpus = corpusOf([
      'Small release today, nothing dramatic, let me know what you think.',
      'Rough week behind us, glad it is over, let me know what you think.',
      'Big milestone for the team this quarter, let me know what you think.',
      'Nothing exciting to report this week, just steady progress on the roadmap.',
    ]);
    const m = measureVoiceCorpus(corpus);
    expect(m.closings).toContain('what you think.');
  });

  describe('reused words', () => {
    it('requires coverage across separate items, not repetition inside one', () => {
      const corpus = corpusOf([
        // "shipped" appears five times, but only in this one item.
        'Shipped shipped shipped shipped shipped campaign search feature this week to a small group of beta testers for validation purposes today.',
        'The team worked hard on the migration this quarter and finally got it across the line yesterday afternoon.',
        'Our team celebrated the launch today after months of careful planning and constant effort this year.',
        'The support team answered every ticket within an hour this week during the incident response effort.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.commonWords).toContain('team');
      expect(m.commonWords).not.toContain('shipped');
    });
  });

  describe('rhythm', () => {
    it('measures median sentence length, spread and how often a piece opens on a short line', () => {
      const corpus = corpusOf([
        'Shipped it. Small change, big relief for everyone on the team this week.',
        'Fixed it. The bug had been hiding in the retry logic for three whole months.',
        'Closed it. The ticket sat open longer than it should have, but it is done.',
      ]);
      const m = measureVoiceCorpus(corpus);
      // Every item opens on a two-word sentence ("Shipped it.", "Fixed it.",
      // "Closed it.") - a clear majority, so the ratio is 1.
      expect(m.rhythm.shortOpeningRatio).toBe(1);
      expect(m.rhythm.fragmentRatio).toBeGreaterThan(0);
      expect(m.rhythm.medianSentenceWords).toBeGreaterThan(0);
    });
  });

  describe('punctuation', () => {
    it('counts a dash used as a pause, not a hyphen inside a word', () => {
      const corpus = corpusOf([
        'the point is - it worked out fine in the end this time.',
        'here is the thing - it shipped a lot faster than planned.',
        'one more note - it held up great under real load today.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.punctuation.dashesPer100Words).toBeGreaterThan(0);
      // Every item opens lowercase on purpose - the majority habit, not the
      // occasional one.
      expect(m.punctuation.capitalizesOpenings).toBe(false);
    });

    it('reads whether a colon is usually followed by a lowercase letter', () => {
      const corpus = corpusOf([
        'The lesson: shortcuts always cost more than they save eventually.',
        'The takeaway: nobody reads the docs until something breaks badly.',
        'The result: fewer support tickets and a much calmer on-call week.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.punctuation.colonsPer100Words).toBeGreaterThan(0);
      expect(m.punctuation.lowercasesAfterColon).toBe(true);
      expect(m.punctuation.capitalizesOpenings).toBe(true);
    });

    it('reports zero, not a guess, for a mark that never appears', () => {
      const corpus = corpusOf([
        'the point is - it worked out fine in the end this time.',
        'here is the thing - it shipped a lot faster than planned.',
        'one more note - it held up great under real load today.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.punctuation.colonsPer100Words).toBe(0);
      expect(m.punctuation.lowercasesAfterColon).toBe(false);
    });
  });

  describe('shape', () => {
    it('finds an emoji or hashtag reused across separate items, not one used once', () => {
      const reused = corpusOf([
        'Shipped the new dashboard today \u{1F389} and it went smoothly overall.',
        'Closed out the migration this week \u{1F389} the team is relieved it is done.',
        'Nothing to report this week, steady progress on the roadmap as usual.',
      ]);
      const m = measureVoiceCorpus(reused);
      expect(m.shape.emoji).toContain('\u{1F389}');

      const once = corpusOf([
        'Shipped the new dashboard today \u{1F389} and it went smoothly overall.',
        'Talked to five customers this week about their onboarding pain points.',
        'Closed out three tickets this afternoon, steady progress on the roadmap.',
      ]);
      expect(measureVoiceCorpus(once).shape.emoji).toEqual([]);
    });

    it('finds the dominant ending style across the corpus', () => {
      const questions = corpusOf([
        'Why does every dashboard ship with five charts nobody asked for?',
        'Why do onboarding flows always assume the user already knows the product?',
        'Why is the default timeout always thirty seconds no matter the API?',
      ]);
      expect(measureVoiceCorpus(questions).shape.ending).toBe('question');

      const claims = corpusOf([
        'Shipped the dashboard today. It went smoothly overall.',
        'Closed out the migration this week. The team is relieved it is done.',
        'Fixed the flaky test suite. It was harder than it looked.',
      ]);
      expect(measureVoiceCorpus(claims).shape.ending).toBe('claim');
    });

    it('mirrors the list-layout register trait rather than re-deriving it', () => {
      const corpus = corpusOf([
        '- shipped the dashboard\n- fixed the flaky test\n- closed the migration ticket today',
        '- talked to five customers\n- learned about pricing\n- wrote up the notes afterward',
        '- reviewed three pull requests\n- merged the small fixes\n- deployed before lunch today',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.traits).toContain('list-layout');
      expect(m.shape.usesLists).toBe(true);
    });
  });

  describe('voice markers', () => {
    it('measures second person, hedges and an imperative opener', () => {
      const corpus = corpusOf([
        'You should probably try this approach on your own project first.',
        'Try shipping smaller changes, you will probably thank yourself later.',
        'Ship the small fix first, then you can decide what comes next.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.voiceMarkers.secondPersonPer100Words).toBeGreaterThan(0);
      expect(m.voiceMarkers.hedgesPer100Words).toBeGreaterThan(0);
      // Two of three sentences open on a known imperative verb ("Try",
      // "Ship") - a real majority, not a guess.
      expect(m.voiceMarkers.imperativeRatio).toBeCloseTo(2 / 3, 2);
    });
  });

  describe('lexicon', () => {
    it('says nothing about an avoided word below the word-count floor', () => {
      const corpus = corpusOf([
        'Shipped a small fix today, nothing dramatic, just steady progress on the roadmap this week.',
        'Talked to a customer about pricing, learned a lot about what they actually need from us.',
        'Closed out three tickets this afternoon, small wins add up over a long enough week.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.wordCount).toBeLessThan(200);
      expect(m.lexicon.avoidedWords).toEqual([]);
    });

    it('reports a candidate word only once the corpus clears the floor, and never one actually used', () => {
      const padding = Array.from(
        { length: 20 },
        (_, i) => `padding word number ${i} about nothing important at all today`,
      ).join('. ');
      const corpus = corpusOf([
        `We should leverage the new pipeline to ship faster. ${padding}.`,
        `The onboarding felt seamless this time around honestly. ${padding}.`,
        `Closed out three tickets this afternoon with the team. ${padding}.`,
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.wordCount).toBeGreaterThanOrEqual(200);
      expect(m.lexicon.avoidedWords).not.toContain('leverage');
      expect(m.lexicon.avoidedWords).not.toContain('seamless');
      expect(m.lexicon.avoidedWords).toContain('humbled');
    });
  });

  describe('language', () => {
    it('classifies English and Italian items and reports both a mix and a per-kind split', () => {
      const corpus: VoiceCorpusItem[] = [
        {
          id: 1,
          kind: 'voice_sample',
          text: 'Shipped the new onboarding flow today, it took three tries to get right.',
        },
        {
          id: 2,
          kind: 'voice_sample',
          text: 'Talked to five different customers this week about the export feature.',
        },
        {
          id: 3,
          kind: 'voice_sample',
          text: 'Fixed a nasty race condition in the background queue this afternoon.',
        },
        {
          id: 4,
          kind: 'message',
          text: 'Abbiamo chiuso la migrazione questa mattina, il team dovrebbe notarlo.',
        },
        {
          id: 5,
          kind: 'message',
          text: 'Il nostro piccolo team ha avuto un trimestre difficile ma produttivo.',
        },
        {
          id: 6,
          kind: 'message',
          text: 'Ho scritto tutta la specifica in aereo senza wifi ne distrazioni.',
        },
      ];
      const m = measureVoiceCorpus(corpus);
      expect(m.language.primary).toBe('mixed');
      expect(m.language.byKind.voice_sample?.primary).toBe('en');
      expect(m.language.byKind.message?.primary).toBe('it');
    });
  });
});

describe('describeVoiceProfile', () => {
  const BASE: VoiceMeasurement = {
    itemCount: 12,
    wordCount: 640,
    measurable: true,
    traits: ['first-person', 'short-sentences'],
    wordsPerSentence: 9,
    openings: ['Just shipped'],
    closings: ['what you think.'],
    commonWords: ['team', 'shipped'],
    rhythm: EMPTY_RHYTHM,
    punctuation: EMPTY_PUNCTUATION,
    shape: EMPTY_SHAPE,
    voiceMarkers: EMPTY_VOICE_MARKERS,
    lexicon: EMPTY_LEXICON,
    language: EMPTY_LANGUAGE,
  };

  it('assembles the measured pieces into prose, omitting whichever came back empty', () => {
    const described = describeVoiceProfile(BASE)!;
    expect(described).toMatch(/12 pieces of their own writing/);
    expect(described).toMatch(/640 words/);
    expect(described).toMatch(/first person, speaking as themselves/);
    expect(described).toMatch(/9 words per sentence/);
    expect(described).toContain('Often opens with "Just shipped"');
    expect(described).toContain('Often closes with "what you think."');
    expect(described).toContain('team, shipped');
    expect(described).not.toMatch(/Tends to end/);
    expect(described).not.toMatch(/Uses these emoji/);
    expect(described).not.toMatch(/Never uses/);
    expect(described).not.toMatch(/Writes primarily/);

    const noPhrasesOrWords: VoiceMeasurement = {
      ...BASE,
      openings: [],
      closings: [],
      commonWords: [],
    };
    const withoutExtras = describeVoiceProfile(noPhrasesOrWords)!;
    expect(withoutExtras).not.toMatch(/Often opens/);
    expect(withoutExtras).not.toMatch(/Often closes/);
    expect(withoutExtras).not.toMatch(/Reuses/);
  });

  it('adds the ending, emoji, hashtag, avoided-word and language sentences only when they say something', () => {
    const rich: VoiceMeasurement = {
      ...BASE,
      shape: {
        ...EMPTY_SHAPE,
        emoji: ['\u{1F680}'],
        hashtags: ['#buildinpublic'],
        ending: 'claim',
      },
      lexicon: { avoidedWords: ['leverage', 'seamless'] },
      language: { primary: 'mixed', englishRatio: 0.5, italianRatio: 0.4, byKind: {} },
    };
    const described = describeVoiceProfile(rich)!;
    expect(described).toContain('Tends to end on a claim.');
    expect(described).toContain('Uses these emoji: \u{1F680}.');
    expect(described).toContain('Uses these hashtags: #buildinpublic.');
    expect(described).toContain('Never uses: leverage, seamless.');
    expect(described).toContain('Writes primarily in both English and Italian.');
  });

  it('says nothing when the corpus was measurable but had no dominant trait, phrase or word', () => {
    const flat: VoiceMeasurement = {
      ...BASE,
      traits: [],
      wordsPerSentence: 0,
      openings: [],
      closings: [],
      commonWords: [],
    };
    expect(describeVoiceProfile(flat)).toBeNull();
  });

  it('returns null outright for an unmeasurable corpus regardless of its counts', () => {
    const tooSmall: VoiceMeasurement = {
      ...BASE,
      itemCount: 2,
      wordCount: 40,
      measurable: false,
      traits: [],
      wordsPerSentence: 0,
      openings: [],
      closings: [],
      commonWords: [],
    };
    expect(describeVoiceProfile(tooSmall)).toBeNull();
  });
});

// LOR-223: a post and a comment are different genres of writing, not the
// same voice at a different length - real evidence from Lorenzo's own
// LinkedIn activity put his posts at a median 122 words against a median 7
// words for his comments, sixteen of twenty-seven comments under ten
// words. The fixtures below invent a corpus at the same order of
// magnitude: three long posts (SHORT_FIRST_PERSON, ~17 words each) and
// five one-to-three-word comments, well under register.ts's own
// MIN_WORDS_TO_DESCRIBE floor for a single item to carry a register.
function corpusOfGenre(
  items: Array<{ text: string; genre: VoiceCorpusItemGenre }>,
): VoiceCorpusItem[] {
  return items.map((item, i) => ({
    id: i + 1,
    kind: 'voice_sample' as const,
    genre: item.genre,
    text: item.text,
  }));
}

const SHORT_COMMENTS = ['🔥', 'Love this!', 'So true', 'Nice work', 'Well said'];

const MIXED_GENRE_CORPUS = corpusOfGenre([
  ...SHORT_FIRST_PERSON.map((text) => ({ text, genre: 'post' as const })),
  ...SHORT_COMMENTS.map((text) => ({ text, genre: 'comment' as const })),
]);

describe('measureVoiceCorpusByGenre', () => {
  it('always returns every genre as a key, even one entirely absent from the corpus', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    expect(Object.keys(byGenre).sort()).toEqual(['comment', 'post', 'reply']);
    expect(byGenre.reply.measurable).toBe(false);
    expect(byGenre.reply.itemCount).toBe(0);
  });

  it('measures a genre honestly once its own item count clears MIN_ITEMS_TO_DERIVE, independent of the other genre', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    expect(byGenre.post.measurable).toBe(true);
    expect(byGenre.post.itemCount).toBe(SHORT_FIRST_PERSON.length);
    expect(byGenre.comment.measurable).toBe(true);
    expect(byGenre.comment.itemCount).toBe(SHORT_COMMENTS.length);
  });

  it('reports comments as far shorter than posts on the same corpus - the whole reason to split them', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    expect(byGenre.comment.rhythm.medianSentenceWords).toBeLessThan(
      byGenre.post.rhythm.medianSentenceWords,
    );
    expect(byGenre.comment.rhythm.medianSentenceWords).toBeLessThanOrEqual(3);
    expect(byGenre.post.rhythm.medianSentenceWords).toBeGreaterThanOrEqual(5);
  });

  it('measures rhythm/shape for a genre whose items are individually too short for register.ts to score, rather than reporting nothing', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    // None of the five comments clears register.ts's 12-word floor, so no
    // register-derived trait or per-item sentence length is available -
    // traits/wordsPerSentence say nothing, honestly - but the corpus as a
    // whole (5 items) clears MIN_ITEMS_TO_DERIVE, so rhythm still measures
    // real sentence-length numbers off the raw text.
    expect(byGenre.comment.traits).toEqual([]);
    expect(byGenre.comment.wordsPerSentence).toBe(0);
    expect(byGenre.comment.measurable).toBe(true);
    expect(byGenre.comment.rhythm.medianSentenceWords).toBeGreaterThan(0);
  });

  it('reports whole-piece length per genre, which is the axis a draft misses widest', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    // The five comments are one-liners and the three posts are several
    // sentences each, so a measurement that cannot tell them apart on
    // length is the defect LOR-231 fixes.
    expect(byGenre.comment.rhythm.medianItemWords).toBeGreaterThan(0);
    expect(byGenre.comment.rhythm.medianItemWords).toBeLessThan(
      byGenre.post.rhythm.medianItemWords,
    );
  });

  it('reports whole-piece length even when every item is too short for register.ts to score', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    // The companion's real corpus looks exactly like this: comments that
    // individually carry no measurable register. Before LOR-231 such a
    // genre described everything about itself except how long it is, and
    // the prompt therefore never told the model to write short.
    expect(byGenre.comment.wordsPerSentence).toBe(0);
    expect(byGenre.comment.rhythm.medianItemWords).toBeGreaterThan(0);
    expect(describeVoiceProfileForGenre('comment', byGenre.comment)).toMatch(
      /A typical one runs about \d+ words/,
    );
  });

  it('leaves a genre with too few items unmeasurable, the same floor the pooled corpus applies', () => {
    const thin = corpusOfGenre([
      { text: SHORT_COMMENTS[0], genre: 'comment' },
      { text: SHORT_COMMENTS[1], genre: 'comment' },
    ]);
    const byGenre = measureVoiceCorpusByGenre(thin);
    expect(byGenre.comment.measurable).toBe(false);
    expect(byGenre.comment.itemCount).toBe(2);
  });
});

describe('describeVoiceProfileForGenre', () => {
  it('words the leading sentence per genre rather than reusing the pooled noun', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    const postDescription = describeVoiceProfileForGenre('post', byGenre.post);
    const commentDescription = describeVoiceProfileForGenre('comment', byGenre.comment);
    expect(postDescription).toMatch(/^Based on 3 of their own posts /);
    expect(commentDescription).toMatch(/^Based on 5 of their own comments /);
  });

  it('a post and a comment description genuinely differ when the two genres differ', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    const postDescription = describeVoiceProfileForGenre('post', byGenre.post);
    const commentDescription = describeVoiceProfileForGenre('comment', byGenre.comment);
    expect(postDescription).not.toBeNull();
    expect(commentDescription).not.toBeNull();
    expect(postDescription).not.toBe(commentDescription);
  });

  it('returns null for a genre with nothing measurable, same as the pooled describeVoiceProfile', () => {
    const byGenre = measureVoiceCorpusByGenre(MIXED_GENRE_CORPUS);
    expect(describeVoiceProfileForGenre('reply', byGenre.reply)).toBeNull();
  });
});

// #570/#571's acceptance: no model call anywhere in the derivation path.
// Asserted by scanning the real source text of the pure measurement module
// and its DB layer, so a future import of a model client or a Gateway call
// fails this test immediately rather than being caught by review.
describe('no model call in the derivation path', () => {
  const FORBIDDEN_PATTERNS = [
    /\bfrom\s+['"]ai['"]/i,
    /@ai-sdk/i,
    /streamText/,
    /generateText/,
    /AI_GATEWAY/,
    /gateway-catalogue/i,
    /agents\/sdk/i,
    /completion\(/,
    /\bfetch\(/,
  ];

  const FILES = [
    '../src/assist/voice-profile.ts',
    '../src/assist/voice-defaults.ts',
    '../src/operator-voice-profile.ts',
  ];

  for (const relativePath of FILES) {
    it(`${relativePath} never imports or calls a model`, () => {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      const source = readFileSync(path, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});

// LOR-44: measureOneText reads the same six axes off a single string,
// reusing every measure* function measureVoiceCorpus itself calls (a
// one-item list rather than a second implementation). What is worth
// pinning here is the floor behaviour a caller comparing two short texts
// depends on: register (and therefore rhythm/punctuation/shape/voice-
// markers) is null below register.ts's own 12-word floor, and language is
// 'unknown' below its own 2-stopword floor - two independent floors, so a
// six-word Italian reply can classify a language while still reporting no
// register at all.
describe('measureOneText', () => {
  it('measures an English, first-person text at or above the register floor', () => {
    const m = measureOneText(
      'I shipped the new dashboard today, and I think it turned out great, honestly.',
    );
    expect(m.wordCount).toBe(14);
    expect(m.register).not.toBeNull();
    expect(m.register?.traits).toContain('first-person');
    expect(m.language).toBe('en');
  });

  it('reports no register below the 12-word floor, even when the language is classifiable', () => {
    const m = measureOneText("che bello, non vedo l'ora!");
    expect(m.wordCount).toBeLessThan(12);
    expect(m.register).toBeNull();
    // Below the floor, rhythm/punctuation/shape/voiceMarkers still return a
    // real (if degenerate) measurement rather than throwing - a caller
    // gates on `register === null` itself rather than this crashing.
    expect(m.rhythm.medianSentenceWords).toBeGreaterThan(0);
    // Two Italian stopword hits ('che', 'non') clear the language floor
    // independently of the (unmet) register floor.
    expect(m.language).toBe('it');
  });

  it('reports language as unknown below its own 2-marker floor', () => {
    const m = measureOneText('Grande!');
    expect(m.register).toBeNull();
    expect(m.language).toBe('unknown');
  });

  it('derives usesLists from its own register trait, matching the corpus-level rule', () => {
    const m = measureOneText(
      'Here is the plan for next week:\n- ship the export feature\n- fix the flaky test\n- write the docs',
    );
    expect(m.register?.traits).toContain('list-layout');
    expect(m.shape.usesLists).toBe(true);
  });

  it('never throws on empty text', () => {
    const m = measureOneText('   ');
    expect(m.wordCount).toBe(0);
    expect(m.register).toBeNull();
    expect(m.language).toBe('unknown');
    expect(m.rhythm).toEqual(EMPTY_RHYTHM);
  });
});

describe('classifyLanguage (exported for style-check.ts and voice-metrics.ts)', () => {
  it('classifies English, Italian and unclassifiable text', () => {
    expect(classifyLanguage('This is the plan for the week and it is going well.')).toBe('en');
    expect(classifyLanguage("che bello, non vedo l'ora!")).toBe('it');
    expect(classifyLanguage('Grande!')).toBe('unknown');
  });

  // LOR-268: measured against real short writing (233 sent messages, 27
  // comments - both gitignored under private/voice-eval/, never quoted
  // here), a plain grammatical-stopword count left about half of it
  // `unknown`: a five-to-ten-word reply routinely carries zero or one
  // stopword, which is below LANGUAGE_MARKER_MIN, but it still carries a
  // greeting, a confirmation or an everyday verb the old marker set never
  // counted. These fixtures are invented, not copied from that corpus, but
  // pin the same category of short reply the old, stopword-only count
  // classified as `unknown`.
  it('classifies a short Italian reply that carries no grammatical stopword', () => {
    // Old code: zero hits in IT_STOPWORDS_GLOBAL -> unknown. New code: four
    // common-word markers ("grazie", "mille", "ci", "domani") clear the
    // floor.
    expect(classifyLanguage('Grazie mille, ci sentiamo domani!')).toBe('it');
  });

  it('classifies a short English reply that carries no grammatical stopword', () => {
    // Old code: zero hits in EN_STOPWORDS_GLOBAL -> unknown. New code:
    // "sure" and "thanks" clear the floor.
    expect(classifyLanguage('Sure, thanks a lot!')).toBe('en');
  });

  it('classifies Italian elision together with one more marker, not alone', () => {
    // "Dell'" is not "della" (IT_STOPWORDS_GLOBAL never sees it) - the
    // elision pattern catches the apostrophe, and "domani" is the second
    // marker the floor still requires.
    expect(classifyLanguage("Dell'iniziativa parliamo domani.")).toBe('it');
  });

  it('still returns unknown for a single common word - the floor is not lowered', () => {
    // "perfetto" is in the expanded marker list, but one marker alone still
    // falls short of LANGUAGE_MARKER_MIN, the same way "Grande!" does above:
    // the fix widens the vocabulary a short reply is measured against, not
    // how many hits are required.
    expect(classifyLanguage('Perfetto!')).toBe('unknown');
  });

  it('stays unknown on a genuine English/Italian tie rather than picking a side', () => {
    // Two Italian markers ("grazie", "mille") and two English markers
    // ("thanks", "my") - a text that is honestly mixed, not one this
    // classifier has evidence to call either way.
    expect(classifyLanguage('Grazie mille, thanks my friend.')).toBe('unknown');
  });
});

// LOR-234: `\b` is defined against the ASCII word-character class, so it
// never treats an accented letter like `è` as a word character - `\bè\b`
// could never match, making that stopword (and any other accented entry)
// dead code. Asserted at the regex itself, not only through
// classifyLanguage, so a regression here is caught at the level it
// happened rather than through a downstream classification.
describe('IT_STOPWORDS_GLOBAL word boundary (LOR-234)', () => {
  it('matches an accented stopword as a standalone word', () => {
    expect('questo è tutto'.match(IT_STOPWORDS_GLOBAL)).toEqual(['questo', 'è']);
  });

  it('does not match an accented stopword inside a longer word', () => {
    expect('cioè'.match(IT_STOPWORDS_GLOBAL)).toBeNull();
  });
});

// LOR-227: an accepted suggestion is text the operator was willing to
// publish, so it counts more than once toward what `measureVoiceCorpus`
// derives - never toward itemCount/wordCount themselves, which stay the
// real, unweighted count of distinct pieces of writing gathered.
describe('accepted_suggestion corpus weighting (LOR-227)', () => {
  it('a corpus with accepted suggestions produces a different profile than the same corpus without them', () => {
    // Two 20-word voice samples and one 4-word accepted suggestion: 3 real
    // items (clears MIN_ITEMS_TO_DERIVE), so itemCount/wordCount are exact.
    // Weighted 2x, the accepted suggestion's 4-word length enters the
    // median twice - [20, 20, 4, 4] medians to 12 - where pooling it flat
    // ([20, 20, 4]) would median to 20. The two corpora below differ only
    // in whether that one item is present at all.
    const voiceSampleA =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
    const voiceSampleB =
      'twenty nineteen eighteen seventeen sixteen fifteen fourteen thirteen twelve eleven ten nine eight seven six five four three two one';
    const withoutAccepted: VoiceCorpusItem[] = [
      { id: 1, kind: 'voice_sample', text: voiceSampleA },
      { id: 2, kind: 'voice_sample', text: voiceSampleB },
    ];
    const withAccepted: VoiceCorpusItem[] = [
      ...withoutAccepted,
      { id: 3, kind: 'accepted_suggestion', genre: 'post', text: 'quick short update today' },
    ];

    // Below MIN_ITEMS_TO_DERIVE without the accepted suggestion - nothing
    // to compare a "different profile" against otherwise.
    expect(measureVoiceCorpus(withoutAccepted).measurable).toBe(false);

    const measured = measureVoiceCorpus(withAccepted);
    expect(measured.measurable).toBe(true);
    // itemCount/wordCount are the real, unweighted counts - not inflated by
    // the accepted suggestion's extra weight.
    expect(measured.itemCount).toBe(3);
    expect(measured.wordCount).toBe(44);
    // The weighted median (12) differs from what flat pooling would have
    // produced (20) - the observable proof the weighting is applied.
    expect(measured.rhythm.medianItemWords).toBe(12);
  });
});

// LOR-227: the edit signature - what an operator habitually cuts between
// the model's own draft (`edited_from`) and what they actually posted
// (`body`). Same discipline as measureVoiceCorpus: a floor before anything
// is reported, and a phrase named only once it recurs across separate
// pairs.
describe('measureEditSignature', () => {
  function pair(id: number, draft: string, final: string): EditPair {
    return { id, draft, final };
  }

  it('reports nothing below MIN_EDIT_PAIRS_TO_DERIVE', () => {
    const pairs = [
      pair(1, 'Great question! Thanks for reading, appreciate it.', 'Thanks for reading.'),
      pair(2, 'Great question! Nice work here.', 'Nice work here.'),
    ];
    expect(pairs.length).toBeLessThan(MIN_EDIT_PAIRS_TO_DERIVE);
    const signature = measureEditSignature(pairs);
    expect(signature).toEqual({ ...EMPTY_EDIT_SIGNATURE, pairCount: 2 });
    expect(hasEditSignatureContent(signature)).toBe(false);
    expect(describeEditSignature(signature)).toBeNull();
  });

  it('names a phrase deleted in two or more pairs, and nothing from a single pair', () => {
    const pairs = [
      pair(
        1,
        'Great question! I think this is really cool, thanks so much for sharing this with everyone.',
        'Cool, thanks for sharing.',
      ),
      pair(
        2,
        'Great question! I appreciate you writing this, it truly resonates with me a lot.',
        'This resonates with me.',
      ),
      // This third draft's own opener ("Nice post here") is unique to this
      // one pair - it must not appear in bannedPhrases.
      pair(
        3,
        'Nice post here, I think this is fantastic and I love reading things like this honestly.',
        'Nice post.',
      ),
    ];
    const signature = measureEditSignature(pairs);
    expect(signature.measurable).toBe(true);
    expect(signature.pairCount).toBe(3);
    expect(signature.bannedPhrases).toEqual(['Great question!']);
    expect(signature.shortensText).toBe(true);
    expect(signature.dropsOpening).toBe(true);
    expect(signature.dropsClosingSentence).toBe(true);
    expect(signature.cutsHedges).toBe(true);
    expect(describeEditSignature(signature)).toContain('"Great question!"');
    expect(describeEditSignature(signature)).toContain('Based on 3 edited suggestions');
  });

  it('derives stripsEmoji and changesLanguage independently of the other axes', () => {
    const emojiPairs = [
      pair(
        1,
        'This is great work here honestly, love seeing it happen this way today 🎉🔥',
        'This is great work here honestly, love seeing it happen this way today.',
      ),
      pair(
        2,
        'Nice update on the project this week, really appreciate the effort put in 🚀',
        'Nice update on the project this week, really appreciate the effort put in.',
      ),
      pair(
        3,
        'Solid progress overall friend, keep it up because it matters a lot to us 🙌',
        'Solid progress overall friend, keep it up because it matters a lot to us.',
      ),
    ];
    const emojiSignature = measureEditSignature(emojiPairs);
    expect(emojiSignature.stripsEmoji).toBe(true);
    expect(emojiSignature.changesLanguage).toBe(false);

    const languagePairs = [
      pair(
        1,
        'This is a great update about the project and the team this week honestly.',
        'Questo è un buon aggiornamento sul progetto di questa settimana onestamente.',
      ),
      pair(
        2,
        'The results are looking really strong for this quarter across every team.',
        'I risultati sembrano davvero forti per questo trimestre in ogni squadra.',
      ),
      pair(
        3,
        'We shipped a new feature today that the whole team is excited about.',
        'Abbiamo lanciato una nuova funzione oggi di cui tutto il team è entusiasta.',
      ),
    ];
    const languageSignature = measureEditSignature(languagePairs);
    expect(languageSignature.changesLanguage).toBe(true);
    expect(languageSignature.stripsEmoji).toBe(false);
  });

  it('ignores an unedited pair (identical draft and final)', () => {
    const pairs = [
      pair(
        1,
        'Same text both times, nothing changed at all here today.',
        'Same text both times, nothing changed at all here today.',
      ),
      pair(2, 'Another edited draft that becomes something shorter.', 'Something shorter.'),
      pair(3, 'A third edited draft that also becomes shorter text.', 'Shorter text.'),
    ];
    // Only 2 of the 3 pairs are real edits - below the floor once the
    // identical one is discarded.
    expect(measureEditSignature(pairs).measurable).toBe(false);
  });
});
