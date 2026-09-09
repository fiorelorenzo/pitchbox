import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  measureVoiceCorpus,
  describeVoiceProfile,
  MIN_ITEMS_TO_DERIVE,
  EMPTY_RHYTHM,
  EMPTY_PUNCTUATION,
  EMPTY_SHAPE,
  EMPTY_VOICE_MARKERS,
  EMPTY_LEXICON,
  EMPTY_LANGUAGE,
  type VoiceCorpusItem,
  type VoiceMeasurement,
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
